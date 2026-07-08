package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM inbox_item WHERE details->>'message_id' = $1`, messageID)
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

	var count int
	var itemType string
	var sourceType string
	if err := testPool.QueryRow(ctx, `
SELECT count(*), max(type), max(details->>'source_type')
FROM inbox_item
WHERE workspace_id = $1
  AND recipient_type = 'member'
  AND recipient_id = $2
  AND details->>'message_id' = $3
`, testWorkspaceID, testUserID, messageID).Scan(&count, &itemType, &sourceType); err != nil {
		t.Fatalf("query inbox item: %v", err)
	}
	if count != 1 || itemType != "new_comment" || sourceType != "feishu" {
		t.Fatalf("created inbox item = count %d type %q source %q", count, itemType, sourceType)
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
