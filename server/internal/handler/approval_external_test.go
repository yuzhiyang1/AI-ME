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
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode reply body: %v", err)
			}
			if body.MsgType != "text" || body.Content == "" {
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
