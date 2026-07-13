package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishu"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestExecuteApprovalSendExternalMessageSendsFeishuReply(t *testing.T) {
	var sawReply bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/v3/tenant_access_token/internal":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":                0,
				"tenant_access_token": "tenant-token",
				"expire":              3600,
			})
		case "/im/v1/messages/om_test/reply":
			if got := r.Header.Get("Authorization"); got != "Bearer tenant-token" {
				t.Fatalf("Authorization header = %q", got)
			}
			var body struct {
				MsgType string `json:"msg_type"`
				Content string `json:"content"`
				UUID    string `json:"uuid"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode reply body: %v", err)
			}
			if body.MsgType != "text" || body.Content == "" || body.UUID == "" {
				t.Fatalf("unexpected reply body: %+v", body)
			}
			sawReply = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]string{"message_id": "om_reply"},
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	h := &Handler{Feishu: feishu.NewClient(feishu.Config{
		AppID:      "app",
		AppSecret:  "secret",
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	})}
	execution, err := h.executeApprovalSendExternalMessage(
		context.Background(),
		db.AiMeApproval{
			SourceType:  "feishu",
			SourceRefID: pgtype.Text{String: "om_test", Valid: true},
		},
		jsonBytesOrObject(map[string]any{
			"channel": "feishu",
			"text":    "确认收到，我会处理。",
		}),
	)
	if err != nil {
		t.Fatalf("executeApprovalSendExternalMessage returned error: %v", err)
	}
	if execution.Status != "succeeded" {
		t.Fatalf("execution status = %q, want succeeded", execution.Status)
	}
	if !sawReply {
		t.Fatal("expected Feishu reply endpoint to be called")
	}
}

func TestExecuteApprovalSendExternalMessageRejectsUnsupportedChannel(t *testing.T) {
	h := &Handler{}
	_, err := h.executeApprovalSendExternalMessage(
		context.Background(),
		db.AiMeApproval{SourceType: "email"},
		jsonBytesOrObject(map[string]any{
			"channel":    "email",
			"message_id": "msg_1",
			"text":       "hello",
		}),
	)
	if err == nil {
		t.Fatal("expected unsupported channel error")
	}
}

func TestApproveAIApprovalRejectsReplyWhileEmployeeTaskIsPending(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}
	ctx := context.Background()
	messageID := "om_waiting_task_" + randomID()
	createReq := newRequest("POST", "/api/ai-me/approvals?workspace_id="+testWorkspaceID, CreateAIApprovalRequest{
		SourceType:         "feishu",
		SourceRefID:        messageID,
		Title:              "等待员工完成后回复",
		Summary:            "员工仍在处理工作项。",
		RiskLevel:          "high",
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "回复飞书消息",
		ActionDescription:  "员工完成后才可批准发送。",
		OriginalPayload:    map[string]any{"channel": "feishu", "message_id": messageID},
		FinalPayload:       map[string]any{"channel": "feishu", "message_id": messageID, "text": "正在处理。", "awaiting_task_result": true},
		AIReasoningSummary: "等待员工结果。",
	})
	w := httptest.NewRecorder()
	testHandler.CreateAIApproval(w, createReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAIApproval: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var approval AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approval); err != nil {
		t.Fatalf("decode approval: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approval.ID)
	})

	approveReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approval.ID+"/approve?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Note: "误点批准"}),
		"id",
		approval.ID,
	)
	w = httptest.NewRecorder()
	testHandler.ApproveAIApproval(w, approveReq)
	if w.Code != http.StatusConflict {
		t.Fatalf("ApproveAIApproval: expected 409, got %d: %s", w.Code, w.Body.String())
	}
	var status string
	if err := testPool.QueryRow(ctx, `SELECT status FROM ai_me_approval WHERE id = $1`, approval.ID).Scan(&status); err != nil {
		t.Fatalf("load approval status: %v", err)
	}
	if status != "pending" {
		t.Fatalf("approval status = %q, want pending", status)
	}
}

func TestRetryAIApprovalExecutionRetriesFailedFeishuSend(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_retry_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	origFeishu := testHandler.Feishu
	testHandler.Feishu = nil
	t.Cleanup(func() {
		testHandler.Feishu = origFeishu
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	createReq := newRequest("POST", "/api/ai-me/approvals?workspace_id="+testWorkspaceID, CreateAIApprovalRequest{
		SourceType:         "feishu",
		SourceRefID:        messageID,
		Title:              "重试飞书回复",
		Summary:            "测试失败后重试发送。",
		RiskLevel:          "high",
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "回复飞书消息",
		ActionDescription:  "批准后通过飞书回复。",
		OriginalPayload:    map[string]any{"channel": "feishu", "message_id": messageID, "text": "收到。"},
		FinalPayload:       map[string]any{"channel": "feishu", "message_id": messageID, "text": "收到，我来处理。"},
		AIReasoningSummary: "外部发送动作必须先审批。",
	})
	w := httptest.NewRecorder()
	testHandler.CreateAIApproval(w, createReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAIApproval: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var approval AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approval); err != nil {
		t.Fatalf("decode approval: %v", err)
	}

	approveReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approval.ID+"/approve?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Note: "允许发送"}),
		"id",
		approval.ID,
	)
	w = httptest.NewRecorder()
	testHandler.ApproveAIApproval(w, approveReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ApproveAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var failed AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&failed); err != nil {
		t.Fatalf("decode failed approval: %v", err)
	}
	if failed.ExecutionStatus != "failed" || !strings.Contains(failed.ExecutionError, "feishu client is not configured") {
		t.Fatalf("failed approval = %+v", failed)
	}

	var sentText string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/v3/tenant_access_token/internal":
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok","tenant_access_token":"tenant-token","expire":3600}`))
		case "/im/v1/messages/" + messageID + "/reply":
			var body struct {
				Content string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode feishu body: %v", err)
			}
			var content struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal([]byte(body.Content), &content); err != nil {
				t.Fatalf("decode feishu content: %v", err)
			}
			sentText = content.Text
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok","data":{"message_id":"om_retry_sent"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	testHandler.Feishu = feishu.NewClient(feishu.Config{
		AppID:      "app",
		AppSecret:  "secret",
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	})

	retryReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approval.ID+"/retry?workspace_id="+testWorkspaceID, nil),
		"id",
		approval.ID,
	)
	w = httptest.NewRecorder()
	testHandler.RetryAIApprovalExecution(w, retryReq)
	if w.Code != http.StatusOK {
		t.Fatalf("RetryAIApprovalExecution: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var retried AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&retried); err != nil {
		t.Fatalf("decode retried approval: %v", err)
	}
	if retried.ExecutionStatus != "succeeded" || sentText != "收到，我来处理。" {
		t.Fatalf("retried approval = %+v sentText=%q", retried, sentText)
	}
	var deliveryStatus string
	var attemptCount int
	if err := testPool.QueryRow(ctx, `
		SELECT status, attempt_count
		FROM ai_me_feishu_delivery
		WHERE approval_id = $1
	`, approval.ID).Scan(&deliveryStatus, &attemptCount); err != nil {
		t.Fatalf("load delivery status: %v", err)
	}
	if deliveryStatus != "succeeded" || attemptCount < 2 {
		t.Fatalf("delivery = %s attempts=%d, want succeeded with retry", deliveryStatus, attemptCount)
	}

	var retryEvents int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM ai_me_approval_event
		WHERE approval_id = $1
		  AND payload->>'retry' = 'true'
	`, approval.ID).Scan(&retryEvents); err != nil {
		t.Fatalf("count retry events: %v", err)
	}
	if retryEvents < 2 {
		t.Fatalf("retry events = %d, want start and result", retryEvents)
	}
}

func TestRetryDueFeishuDeliveriesAutomaticallyRecoversFailedSend(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_auto_retry_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	origFeishu := testHandler.Feishu
	testHandler.Feishu = nil
	t.Setenv("AI_ME_FEISHU_SEND_MAX_ATTEMPTS", "3")
	t.Cleanup(func() {
		testHandler.Feishu = origFeishu
		cleanupFeishuMessageTestRows(ctx, messageID)
	})

	createReq := newRequest("POST", "/api/ai-me/approvals?workspace_id="+testWorkspaceID, CreateAIApprovalRequest{
		SourceType:         "feishu",
		SourceRefID:        messageID,
		Title:              "自动重试飞书回复",
		Summary:            "测试到期发送自动恢复。",
		RiskLevel:          "high",
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "回复飞书消息",
		ActionDescription:  "批准后通过飞书回复。",
		OriginalPayload:    map[string]any{"channel": "feishu", "message_id": messageID, "text": "收到。"},
		FinalPayload:       map[string]any{"channel": "feishu", "message_id": messageID, "text": "自动重试已恢复。"},
		AIReasoningSummary: "外部发送动作必须先审批。",
	})
	w := httptest.NewRecorder()
	testHandler.CreateAIApproval(w, createReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAIApproval: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var approval AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approval); err != nil {
		t.Fatalf("decode approval: %v", err)
	}

	approveReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approval.ID+"/approve?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Note: "允许发送"}),
		"id",
		approval.ID,
	)
	w = httptest.NewRecorder()
	testHandler.ApproveAIApproval(w, approveReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ApproveAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE ai_me_feishu_delivery
		SET next_retry_at = now() - interval '1 second'
		WHERE approval_id = $1
	`, approval.ID); err != nil {
		t.Fatalf("make delivery due: %v", err)
	}

	var sentText string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth/v3/tenant_access_token/internal":
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok","tenant_access_token":"tenant-token","expire":3600}`))
		case "/im/v1/messages/" + messageID + "/reply":
			var body struct {
				Content string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode feishu body: %v", err)
			}
			var content struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal([]byte(body.Content), &content); err != nil {
				t.Fatalf("decode feishu content: %v", err)
			}
			sentText = content.Text
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok","data":{"message_id":"om_auto_retry_sent"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	testHandler.Feishu = feishu.NewClient(feishu.Config{
		AppID:      "app",
		AppSecret:  "secret",
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	})

	processed, err := testHandler.RetryDueFeishuDeliveries(ctx, 10)
	if err != nil {
		t.Fatalf("RetryDueFeishuDeliveries: %v", err)
	}
	if processed != 1 || sentText != "自动重试已恢复。" {
		t.Fatalf("processed=%d sentText=%q, want one recovered delivery", processed, sentText)
	}

	var deliveryStatus, executionStatus string
	var automaticEvents int
	if err := testPool.QueryRow(ctx, `
		SELECT d.status, a.execution_status,
		       (SELECT count(*) FROM ai_me_approval_event e
		        WHERE e.approval_id = a.id
		          AND e.actor_type = 'ai_me'
		          AND e.payload->>'automatic' = 'true')
		FROM ai_me_feishu_delivery d
		JOIN ai_me_approval a ON a.id = d.approval_id
		WHERE d.approval_id = $1
	`, approval.ID).Scan(&deliveryStatus, &executionStatus, &automaticEvents); err != nil {
		t.Fatalf("load automatic retry result: %v", err)
	}
	if deliveryStatus != "succeeded" || executionStatus != "succeeded" || automaticEvents < 2 {
		t.Fatalf("delivery=%s approval=%s automatic_events=%d", deliveryStatus, executionStatus, automaticEvents)
	}
}

func TestRetryDueFeishuDeliveriesLeavesDeadLettersForManualRecovery(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const messageID = "om_ai_me_dead_letter_test"
	ctx := context.Background()
	cleanupFeishuMessageTestRows(ctx, messageID)
	t.Cleanup(func() { cleanupFeishuMessageTestRows(ctx, messageID) })

	createReq := newRequest("POST", "/api/ai-me/approvals?workspace_id="+testWorkspaceID, CreateAIApprovalRequest{
		SourceType:         "feishu",
		SourceRefID:        messageID,
		Title:              "死信人工恢复",
		Summary:            "死信不得继续自动发送。",
		RiskLevel:          "high",
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "回复飞书消息",
		ActionDescription:  "批准后通过飞书回复。",
		OriginalPayload:    map[string]any{"channel": "feishu", "message_id": messageID, "text": "收到。"},
		FinalPayload:       map[string]any{"channel": "feishu", "message_id": messageID, "text": "需要人工恢复。"},
		AIReasoningSummary: "超过自动重试上限后转入死信。",
	})
	w := httptest.NewRecorder()
	testHandler.CreateAIApproval(w, createReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAIApproval: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var approval AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approval); err != nil {
		t.Fatalf("decode approval: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE ai_me_approval
		SET status = 'approved', execution_status = 'failed', execution_error = 'retry limit reached'
		WHERE id = $1
	`, approval.ID); err != nil {
		t.Fatalf("prepare failed approval: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO ai_me_feishu_delivery (
			workspace_id, approval_id, source_message_id, status, attempt_count, last_error
		) VALUES ($2, $1, $3, 'dead_letter', 3, 'retry limit reached')
	`, approval.ID, testWorkspaceID, messageID); err != nil {
		t.Fatalf("prepare dead letter: %v", err)
	}

	processed, err := testHandler.RetryDueFeishuDeliveries(ctx, 10)
	if err != nil {
		t.Fatalf("RetryDueFeishuDeliveries: %v", err)
	}
	if processed != 0 {
		t.Fatalf("processed=%d, want dead letter to require manual recovery", processed)
	}
	var status string
	if err := testPool.QueryRow(ctx, `SELECT status FROM ai_me_feishu_delivery WHERE approval_id = $1`, approval.ID).Scan(&status); err != nil {
		t.Fatalf("load dead letter: %v", err)
	}
	if status != "dead_letter" {
		t.Fatalf("delivery status=%q, want dead_letter", status)
	}
}

func TestRateAIApprovalRecordsQualityReview(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture is not available")
	}

	const sourceRef = "quality-review-test"
	ctx := context.Background()
	_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE source_ref_id = $1`, sourceRef)
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE source_ref_id = $1`, sourceRef)
	})

	createReq := newRequest("POST", "/api/ai-me/approvals?workspace_id="+testWorkspaceID, CreateAIApprovalRequest{
		SourceType:         "manual",
		SourceRefID:        sourceRef,
		Title:              "质量评分测试",
		Summary:            "用于验证审批质量评分。",
		RiskLevel:          "medium",
		Reversibility:      "reversible",
		ActionType:         "no_action",
		ActionTitle:        "无需动作",
		ActionDescription:  "只记录评分。",
		OriginalPayload:    map[string]any{"source": "test"},
		FinalPayload:       map[string]any{"source": "test"},
		AIReasoningSummary: "测试审批质量评分。",
	})
	w := httptest.NewRecorder()
	testHandler.CreateAIApproval(w, createReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAIApproval: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var approval AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approval); err != nil {
		t.Fatalf("decode approval: %v", err)
	}

	rateReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approval.ID+"/quality?workspace_id="+testWorkspaceID, AIApprovalQualityRequest{
			Score:   4,
			Note:    "回复方向正确，但还可以更具体。",
			Outcome: "accepted",
		}),
		"id",
		approval.ID,
	)
	w = httptest.NewRecorder()
	testHandler.RateAIApproval(w, rateReq)
	if w.Code != http.StatusOK {
		t.Fatalf("RateAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var rated AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&rated); err != nil {
		t.Fatalf("decode rated approval: %v", err)
	}
	if len(rated.Events) == 0 {
		t.Fatalf("rated approval has no events: %+v", rated)
	}
	var storedScore int
	if err := testPool.QueryRow(ctx, `
		SELECT (payload->>'score')::int
		FROM ai_me_approval_event
		WHERE approval_id = $1
		  AND event_type = 'edited'
		  AND payload->>'kind' = 'quality_review'
		ORDER BY created_at DESC
		LIMIT 1
	`, approval.ID).Scan(&storedScore); err != nil {
		t.Fatalf("load quality score: %v", err)
	}
	if storedScore != 4 {
		t.Fatalf("stored score = %d, want 4", storedScore)
	}
}
