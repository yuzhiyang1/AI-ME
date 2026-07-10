package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	channeltypes "github.com/larksuite/oapi-sdk-go/v3/channel/types"
	"github.com/multica-ai/multica/server/internal/feishu"
)

func TestFeishuOwnerMentionedMatchesAllowedOpenID(t *testing.T) {
	message := feishuMessage{
		MessageType: "text",
		Content:     `{"text":"帮我看一下 @玉旨杨","mentions":[{"name":"玉旨杨","id":{"open_id":"ou_owner","user_id":"u_owner"}}]}`,
	}

	if !feishuOwnerMentioned(message, feishuConfig{AllowedOpenID: "ou_owner"}) {
		t.Fatal("expected owner mention to match allowed open_id")
	}
}

func TestFeishuOwnerMentionedIgnoresUnrelatedMention(t *testing.T) {
	message := feishuMessage{
		MessageType: "text",
		Content:     `{"text":"参会人员 @张三","mentions":[{"name":"张三","id":{"open_id":"ou_other","user_id":"u_other"}}]}`,
	}

	if feishuOwnerMentioned(message, feishuConfig{AllowedOpenID: "ou_owner", OwnerName: "玉旨杨"}) {
		t.Fatal("expected unrelated mention to be ignored")
	}
}

func TestFeishuInboundGateAcceptsDirectMessage(t *testing.T) {
	payload := feishuEventCallback{
		Event: feishuEventBody{
			Message: feishuMessage{ChatType: "p2p"},
		},
	}

	gate := feishuInboundGate(payload, feishuConfig{})
	if !gate.Accept || gate.Reason != "p2p" {
		t.Fatalf("gate = %+v, want p2p accept", gate)
	}
}

func TestFeishuInboundGateRejectsGroupWithoutMention(t *testing.T) {
	payload := feishuEventCallback{
		Event: feishuEventBody{
			Message: feishuMessage{
				ChatType:    "group",
				MessageType: "text",
				Content:     `{"text":"大家看一下","mentions":[]}`,
			},
		},
	}

	gate := feishuInboundGate(payload, feishuConfig{OwnerName: "玉旨杨"})
	if gate.Accept || gate.Reason != "group_message_without_owner_mention" {
		t.Fatalf("gate = %+v, want group reject", gate)
	}
}

func TestFeishuPayloadFromNormalizedMessagePreservesTextAndMentions(t *testing.T) {
	payload := feishuPayloadFromNormalizedMessage(&channeltypes.NormalizedMessage{
		EventID:        "evt_ws_test",
		MessageID:      "om_ws_test",
		ChatID:         "oc_ws_test",
		ChatType:       "group",
		UserID:         "u_colleague",
		Content:        "帮我看一下 @玉旨杨",
		RawContentType: "text",
		CreateTimeMs:   1773491924409,
		Mentions: []channeltypes.Mention{
			{
				Key:    "@_user_1",
				OpenID: "ou_owner",
				UserID: "u_owner",
				Name:   "玉旨杨",
			},
		},
	})

	if payload.Header.EventType != "im.message.receive_v1" {
		t.Fatalf("event type = %q, want im.message.receive_v1", payload.Header.EventType)
	}
	if payload.Event.Message.MessageType != "text" {
		t.Fatalf("message type = %q, want text", payload.Event.Message.MessageType)
	}
	if got := feishuMessageText(payload.Event.Message); got != "帮我看一下 @玉旨杨" {
		t.Fatalf("message text = %q", got)
	}
	if !feishuOwnerMentioned(payload.Event.Message, feishuConfig{AllowedOpenID: "ou_owner"}) {
		t.Fatal("expected normalized mention to match allowed open_id")
	}
}

func TestGetFeishuIntegrationStatusReportsWebhookConfiguration(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	t.Setenv("FEISHU_EVENT_MODE", "webhook")
	t.Setenv("FEISHU_WEBHOOK_TOKEN", "test-token")
	t.Setenv("FEISHU_WORKSPACE_ID", testWorkspaceID)
	t.Setenv("FEISHU_WORKSPACE_SLUG", "")
	t.Setenv("FEISHU_OWNER_USER_ID", testUserID)
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	t.Setenv("FEISHU_GROUP_MESSAGE_POLICY", "mention")

	origFeishu := testHandler.Feishu
	testHandler.Feishu = feishu.NewClient(feishu.Config{AppID: "cli_test", AppSecret: "test-secret"})
	t.Cleanup(func() { testHandler.Feishu = origFeishu })

	req := newRequest(http.MethodGet, "/api/integrations/feishu/status?workspace_id="+testWorkspaceID, nil)
	w := httptest.NewRecorder()
	testHandler.GetFeishuIntegrationStatus(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GetFeishuIntegrationStatus: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp FeishuIntegrationStatusResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if resp.Provider != "feishu" || resp.EventMode != "webhook" {
		t.Fatalf("provider/mode = %s/%s", resp.Provider, resp.EventMode)
	}
	if !resp.IncomingConfigured || !resp.OutgoingConfigured || !resp.WorkspaceMatches {
		t.Fatalf("status = %+v, want incoming/outgoing/workspace match", resp)
	}
	if !resp.WebhookConfigured || !resp.WorkspaceConfigured || !resp.OwnerConfigured {
		t.Fatalf("status = %+v, want webhook/workspace/owner configured", resp)
	}
	if len(resp.RequiredEvents) == 0 || len(resp.RequiredScopes) == 0 {
		t.Fatalf("missing required event/scope hints: %+v", resp)
	}
	for _, warning := range resp.Warnings {
		if warning == "reply_client_not_configured" || warning == "workspace_mismatch" {
			t.Fatalf("unexpected warning %q in %+v", warning, resp)
		}
	}
}

func TestFeishuWebhookCreatesAIMeInboxItemAndDeduplicates(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_intake_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	origModel := testHandler.AIModel
	testHandler.AIModel = nil
	t.Cleanup(func() {
		testHandler.AIModel = origModel
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	t.Setenv("FEISHU_WEBHOOK_TOKEN", "test-token")
	t.Setenv("FEISHU_WORKSPACE_ID", testWorkspaceID)
	t.Setenv("FEISHU_WORKSPACE_SLUG", "")
	t.Setenv("FEISHU_OWNER_USER_ID", testUserID)
	t.Setenv("FEISHU_ALLOWED_CHAT_ID", "")
	t.Setenv("FEISHU_GROUP_MESSAGE_POLICY", "mention")

	payload := feishuEventCallback{
		Header: feishuHeader{
			EventID:   "evt_ai_me_intake_test",
			EventType: "im.message.receive_v1",
			Token:     "test-token",
		},
		Event: feishuEventBody{
			Sender: feishuSender{
				SenderType: "user",
				SenderID: feishuSenderID{
					OpenID: "ou_colleague",
					UserID: "u_colleague",
				},
			},
			Message: feishuMessage{
				MessageID:   messageID,
				ChatID:      "oc_test",
				ChatType:    "p2p",
				MessageType: "text",
				Content:     `{"text":"帮我看一下退款状态"}`,
			},
		},
	}

	w := httptest.NewRecorder()
	testHandler.FeishuWebhook(w, feishuWebhookRequest(t, payload))
	if w.Code != http.StatusAccepted {
		t.Fatalf("first webhook status = %d, body = %s", w.Code, w.Body.String())
	}
	var firstResp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&firstResp); err != nil {
		t.Fatalf("decode first webhook response: %v", err)
	}
	approvalID, _ := firstResp["approval_id"].(string)
	if approvalID == "" {
		t.Fatalf("expected approval_id in webhook response, got %#v", firstResp)
	}

	var count int
	var inboxID string
	var itemType string
	var sourceType string
	var approvalIDInDetails string
	if err := testPool.QueryRow(ctx, `
SELECT count(*), max(id::text), max(type), max(details->>'source_type'), max(details->>'approval_id')
FROM inbox_item
WHERE workspace_id = $1
  AND recipient_type = 'member'
  AND recipient_id = $2
  AND details->>'message_id' = $3
`, testWorkspaceID, testUserID, messageID).Scan(&count, &inboxID, &itemType, &sourceType, &approvalIDInDetails); err != nil {
		t.Fatalf("query inbox item: %v", err)
	}
	if count != 1 || itemType != "new_comment" || sourceType != "feishu" {
		t.Fatalf("created inbox item = count %d type %q source %q", count, itemType, sourceType)
	}
	if approvalIDInDetails != approvalID {
		t.Fatalf("inbox approval_id = %q, want %q", approvalIDInDetails, approvalID)
	}

	var (
		approvalSourceType string
		approvalSourceRef  string
		approvalActionType string
		approvalInboxID    string
		finalPayloadRaw    []byte
	)
	if err := testPool.QueryRow(ctx, `
SELECT source_type, source_ref_id, action_type, inbox_item_id::text, final_payload
FROM ai_me_approval
WHERE id = $1
`, approvalID).Scan(&approvalSourceType, &approvalSourceRef, &approvalActionType, &approvalInboxID, &finalPayloadRaw); err != nil {
		t.Fatalf("query linked approval: %v", err)
	}
	if approvalSourceType != "feishu" || approvalSourceRef != messageID || approvalActionType != "send_external_message" || approvalInboxID != inboxID {
		t.Fatalf("linked approval = source %q ref %q action %q inbox %q, want feishu/%s/send_external_message/%s",
			approvalSourceType, approvalSourceRef, approvalActionType, approvalInboxID, messageID, inboxID)
	}
	var finalPayload map[string]any
	if err := json.Unmarshal(finalPayloadRaw, &finalPayload); err != nil {
		t.Fatalf("decode final payload: %v", err)
	}
	if finalPayload["channel"] != "feishu" || finalPayload["message_id"] != messageID || finalPayload["chat_id"] != "oc_test" {
		t.Fatalf("final payload = %#v, want feishu reply metadata", finalPayload)
	}
	if finalPayload["text"] != "收到，我会看一下并尽快回复你。" {
		t.Fatalf("final payload text = %#v", finalPayload["text"])
	}

	w = httptest.NewRecorder()
	testHandler.FeishuWebhook(w, feishuWebhookRequest(t, payload))
	if w.Code != http.StatusOK {
		t.Fatalf("duplicate webhook status = %d, body = %s", w.Code, w.Body.String())
	}
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM inbox_item WHERE details->>'message_id' = $1`, messageID).Scan(&count); err != nil {
		t.Fatalf("count duplicate inbox item: %v", err)
	}
	if count != 1 {
		t.Fatalf("duplicate created %d inbox items, want 1", count)
	}
	if err := testPool.QueryRow(ctx, `
SELECT count(*)
FROM ai_me_approval
WHERE workspace_id = $1
  AND source_type = 'feishu'
  AND source_ref_id = $2
`, testWorkspaceID, messageID).Scan(&count); err != nil {
		t.Fatalf("count duplicate approval: %v", err)
	}
	if count != 1 {
		t.Fatalf("duplicate created %d approvals, want 1", count)
	}
}

func TestFeishuWebhookRejectsInvalidSignatureAndRecordsEvent(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_bad_signature_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	t.Cleanup(func() {
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	t.Setenv("FEISHU_WEBHOOK_TOKEN", "test-token")
	t.Setenv("FEISHU_ENCRYPT_KEY", "encrypt-key")
	t.Setenv("FEISHU_WORKSPACE_ID", testWorkspaceID)
	t.Setenv("FEISHU_WORKSPACE_SLUG", "")
	t.Setenv("FEISHU_OWNER_USER_ID", testUserID)

	payload := feishuEventCallback{
		Header: feishuHeader{
			EventID:   "evt_ai_me_bad_signature_test",
			EventType: "im.message.receive_v1",
			Token:     "test-token",
		},
		Event: feishuEventBody{
			Message: feishuMessage{
				MessageID:   messageID,
				ChatID:      "oc_signature_test",
				ChatType:    "p2p",
				MessageType: "text",
				Content:     `{"text":"签名失败测试"}`,
			},
		},
	}

	req := feishuWebhookRequest(t, payload)
	req.Header.Set("X-Lark-Request-Timestamp", strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set("X-Lark-Request-Nonce", "nonce")
	req.Header.Set("X-Lark-Signature", "bad-signature")
	w := httptest.NewRecorder()
	testHandler.FeishuWebhook(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("webhook status = %d, body = %s", w.Code, w.Body.String())
	}

	var status, reason string
	var signatureVerified bool
	if err := testPool.QueryRow(ctx, `
SELECT status, reason, signature_verified
FROM ai_me_feishu_webhook_event
WHERE event_id = 'evt_ai_me_bad_signature_test'
`).Scan(&status, &reason, &signatureVerified); err != nil {
		t.Fatalf("query rejected event: %v", err)
	}
	if status != "rejected" || reason != "signature_mismatch" || signatureVerified {
		t.Fatalf("event = status %q reason %q signature %v", status, reason, signatureVerified)
	}
}

func TestFeishuWebhookSignedRequestRecordsReliability(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_signed_intake_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	origModel := testHandler.AIModel
	testHandler.AIModel = nil
	t.Cleanup(func() {
		testHandler.AIModel = origModel
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	t.Setenv("FEISHU_WEBHOOK_TOKEN", "test-token")
	t.Setenv("FEISHU_ENCRYPT_KEY", "encrypt-key")
	t.Setenv("FEISHU_WORKSPACE_ID", testWorkspaceID)
	t.Setenv("FEISHU_WORKSPACE_SLUG", "")
	t.Setenv("FEISHU_OWNER_USER_ID", testUserID)
	t.Setenv("FEISHU_ALLOWED_CHAT_ID", "")
	t.Setenv("FEISHU_GROUP_MESSAGE_POLICY", "mention")

	payload := feishuEventCallback{
		Header: feishuHeader{
			EventID:   "evt_ai_me_signed_intake_test",
			EventType: "im.message.receive_v1",
			Token:     "test-token",
		},
		Event: feishuEventBody{
			Sender: feishuSender{
				SenderType: "user",
				SenderID:   feishuSenderID{OpenID: "ou_signed", UserID: "u_signed"},
			},
			Message: feishuMessage{
				MessageID:   messageID,
				ChatID:      "oc_signature_test",
				ChatType:    "p2p",
				MessageType: "text",
				Content:     `{"text":"签名成功测试"}`,
			},
		},
	}

	w := httptest.NewRecorder()
	testHandler.FeishuWebhook(w, signedFeishuWebhookRequest(t, payload, "encrypt-key"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, body = %s", w.Code, w.Body.String())
	}

	var status string
	var signatureVerified, replayProtected bool
	if err := testPool.QueryRow(ctx, `
SELECT status, signature_verified, replay_protected
FROM ai_me_feishu_webhook_event
WHERE event_id = 'evt_ai_me_signed_intake_test'
`).Scan(&status, &signatureVerified, &replayProtected); err != nil {
		t.Fatalf("query accepted event: %v", err)
	}
	if status != "accepted" || !signatureVerified || !replayProtected {
		t.Fatalf("event = status %q signature %v replay %v", status, signatureVerified, replayProtected)
	}
}

func TestFeishuWebhookUsesAIMeModelForReplyDraft(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_model_draft_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	var capturedPrompt string
	origModel := testHandler.AIModel
	testHandler.AIModel = fakeAIMeModelClient{
		content: `{
			"summary":"需要回复退款状态咨询",
			"risk_level":"medium",
			"confidence":0.82,
			"need_approval":true,
			"reply_draft":"您好，退款状态我来确认一下，稍后给您同步结果。",
			"reasoning_summary":"用户在飞书中询问退款状态，适合先确认会跟进，不承诺具体结果。",
			"evidence":[{"type":"user_input","label":"飞书消息","quote":"退款状态"}]
		}`,
		onComplete: func(_ string, userPrompt string) {
			capturedPrompt = userPrompt
		},
	}
	t.Cleanup(func() {
		testHandler.AIModel = origModel
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	t.Setenv("FEISHU_WEBHOOK_TOKEN", "test-token")
	t.Setenv("FEISHU_WORKSPACE_ID", testWorkspaceID)
	t.Setenv("FEISHU_WORKSPACE_SLUG", "")
	t.Setenv("FEISHU_OWNER_USER_ID", testUserID)
	t.Setenv("FEISHU_ALLOWED_CHAT_ID", "")
	t.Setenv("FEISHU_GROUP_MESSAGE_POLICY", "mention")

	payload := feishuEventCallback{
		Header: feishuHeader{
			EventID:   "evt_ai_me_model_draft_test",
			EventType: "im.message.receive_v1",
			Token:     "test-token",
		},
		Event: feishuEventBody{
			Sender: feishuSender{
				SenderType: "user",
				SenderID: feishuSenderID{
					OpenID: "ou_colleague",
					UserID: "u_colleague",
				},
			},
			Message: feishuMessage{
				MessageID:   messageID,
				ChatID:      "oc_model_test",
				ChatType:    "p2p",
				MessageType: "text",
				Content:     `{"text":"帮我看一下退款状态，客户比较着急"}`,
			},
		},
	}

	w := httptest.NewRecorder()
	testHandler.FeishuWebhook(w, feishuWebhookRequest(t, payload))
	if w.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(capturedPrompt, "客户比较着急") || !strings.Contains(capturedPrompt, "feishu") {
		t.Fatalf("model prompt did not include Feishu message context: %s", capturedPrompt)
	}

	var approvalID string
	if err := json.NewDecoder(w.Body).Decode(&struct {
		ApprovalID *string `json:"approval_id"`
	}{ApprovalID: &approvalID}); err != nil {
		t.Fatalf("decode webhook response: %v", err)
	}
	if approvalID == "" {
		t.Fatal("expected approval_id")
	}

	var (
		summary         string
		reasoning       string
		confidence      float64
		finalPayloadRaw []byte
	)
	if err := testPool.QueryRow(ctx, `
SELECT summary, ai_reasoning_summary, confidence::float8, final_payload
FROM ai_me_approval
WHERE id = $1
`, approvalID).Scan(&summary, &reasoning, &confidence, &finalPayloadRaw); err != nil {
		t.Fatalf("query approval: %v", err)
	}
	if summary != "需要回复退款状态咨询" || reasoning != "用户在飞书中询问退款状态，适合先确认会跟进，不承诺具体结果。" {
		t.Fatalf("approval summary/reasoning = %q / %q", summary, reasoning)
	}
	if confidence != 0.82 {
		t.Fatalf("confidence = %v, want 0.82", confidence)
	}
	var finalPayload map[string]any
	if err := json.Unmarshal(finalPayloadRaw, &finalPayload); err != nil {
		t.Fatalf("decode final payload: %v", err)
	}
	if finalPayload["text"] != "您好，退款状态我来确认一下，稍后给您同步结果。" {
		t.Fatalf("final payload text = %#v", finalPayload["text"])
	}
	if finalPayload["draft_source"] != "ai_model" || finalPayload["draft_provider"] != "fake" || finalPayload["draft_model"] != "fake-model" {
		t.Fatalf("final payload draft metadata = %#v", finalPayload)
	}
}

func TestListFeishuLogsReturnsDogfoodPanel(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_log_panel_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	origModel := testHandler.AIModel
	testHandler.AIModel = nil
	t.Cleanup(func() {
		testHandler.AIModel = origModel
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	t.Setenv("FEISHU_WEBHOOK_TOKEN", "test-token")
	t.Setenv("FEISHU_WORKSPACE_ID", testWorkspaceID)
	t.Setenv("FEISHU_WORKSPACE_SLUG", "")
	t.Setenv("FEISHU_OWNER_USER_ID", testUserID)
	t.Setenv("FEISHU_ALLOWED_CHAT_ID", "")
	t.Setenv("FEISHU_GROUP_MESSAGE_POLICY", "mention")
	t.Setenv("AI_ME_LLM_DRAFT_COST_CENTS", "9")
	t.Setenv("AI_ME_DAILY_BUDGET_CENTS", "20")

	payload := feishuEventCallback{
		Header: feishuHeader{
			EventID:   "evt_ai_me_log_panel_test",
			EventType: "im.message.receive_v1",
			Token:     "test-token",
		},
		Event: feishuEventBody{
			Sender: feishuSender{
				SenderType: "user",
				SenderID: feishuSenderID{
					OpenID: "ou_colleague_log",
					UserID: "u_colleague_log",
				},
			},
			Message: feishuMessage{
				MessageID:   messageID,
				ChatID:      "oc_log_test",
				ChatType:    "p2p",
				MessageType: "text",
				Content:     `{"text":"帮我确认一下测试日志面板"}`,
			},
		},
	}

	w := httptest.NewRecorder()
	testHandler.FeishuWebhook(w, feishuWebhookRequest(t, payload))
	if w.Code != http.StatusAccepted {
		t.Fatalf("webhook status = %d, body = %s", w.Code, w.Body.String())
	}

	req := newRequest(http.MethodGet, "/api/integrations/feishu/logs?workspace_id="+testWorkspaceID+"&limit=5", nil)
	w = httptest.NewRecorder()
	testHandler.ListFeishuLogs(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListFeishuLogs: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp FeishuDogfoodPanelResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode logs response: %v", err)
	}
	if len(resp.Logs) == 0 || resp.Logs[0].MessageID != messageID {
		t.Fatalf("logs = %#v, want newest message %s", resp.Logs, messageID)
	}
	if resp.Logs[0].ApprovalID == "" || resp.Logs[0].ExecutionStatus != "not_started" {
		t.Fatalf("log approval metadata = %#v", resp.Logs[0])
	}
	if resp.Summary.TotalReceived < 1 || resp.Summary.DogfoodCompleted != 0 || resp.Summary.DogfoodTarget != 20 {
		t.Fatalf("summary = %+v, want dogfood progress", resp.Summary)
	}
	if len(resp.Cases) != 20 {
		t.Fatalf("dogfood cases = %d, want 20 executable slots", len(resp.Cases))
	}
	var matchedCase *FeishuDogfoodCaseResponse
	for i := range resp.Cases {
		if resp.Cases[i].MessageID == messageID {
			matchedCase = &resp.Cases[i]
			break
		}
	}
	if matchedCase == nil || matchedCase.Stage != "pending_approval" || matchedCase.Completed {
		t.Fatalf("dogfood case = %#v, want pending approval", matchedCase)
	}
	if resp.Onboarding.TotalSteps == 0 || resp.Onboarding.CompletedSteps == 0 {
		t.Fatalf("onboarding = %+v, want at least configured workspace steps", resp.Onboarding)
	}
	if resp.Cost.DailyBudgetCents != 20 || resp.Cost.BudgetStatus == "" {
		t.Fatalf("cost = %+v, want configured budget", resp.Cost)
	}
}

func feishuWebhookRequest(t *testing.T, payload feishuEventCallback) *http.Request {
	t.Helper()

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal webhook payload: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/feishu/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func signedFeishuWebhookRequest(t *testing.T, payload feishuEventCallback, encryptKey string) *http.Request {
	t.Helper()

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal webhook payload: %v", err)
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := "test-nonce"
	signature := sha256Hex(append([]byte(timestamp+nonce+encryptKey), body...))
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/feishu/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lark-Request-Timestamp", timestamp)
	req.Header.Set("X-Lark-Request-Nonce", nonce)
	req.Header.Set("X-Lark-Signature", signature)
	return req
}

func cleanupFeishuMessageTestRows(ctx context.Context, messageID string) {
	_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_feishu_delivery WHERE source_message_id = $1`, messageID)
	_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_feishu_webhook_event WHERE message_id = $1 OR event_id LIKE '%' || $1 || '%'`, messageID)
	_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE source_type = 'feishu' AND source_ref_id = $1`, messageID)
	_, _ = testPool.Exec(ctx, `DELETE FROM inbox_item WHERE details->>'message_id' = $1`, messageID)
}
