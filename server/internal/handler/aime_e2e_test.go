package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/feishu"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestAIMeOrchestrationE2EIssueApprovalReplyTraceAndMemory(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	member, err := testHandler.getWorkspaceMember(ctx, testUserID, testWorkspaceID)
	if err != nil {
		t.Fatalf("load member: %v", err)
	}

	var oldSettings []byte
	if err := testPool.QueryRow(ctx, `SELECT settings FROM workspace WHERE id = $1`, testWorkspaceID).Scan(&oldSettings); err != nil {
		t.Fatalf("load workspace settings: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `UPDATE workspace SET settings = $1 WHERE id = $2`, oldSettings, testWorkspaceID)
	})
	if _, err := testPool.Exec(ctx, `
		UPDATE workspace
		SET settings = '{"ai_me":{"enabled":true,"autonomy_level":"balanced","approval_mode":"always","timezone":"Asia/Shanghai","working_hours":{"start":"00:00","end":"00:00"},"model_provider":"deepseek","model_name":"deepseek-chat"}}'::jsonb
		WHERE id = $1
	`, testWorkspaceID); err != nil {
		t.Fatalf("update workspace settings: %v", err)
	}

	w := httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "AI-Me E2E refund escalation",
		"status":   "todo",
		"priority": "high",
	}))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
		t.Fatalf("decode issue: %v", err)
	}

	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent
		WHERE workspace_id = $1 AND name = 'Handler Test Agent'
		ORDER BY created_at ASC
		LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load handler test agent: %v", err)
	}

	var memoryID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO memory_entry (
			workspace_id, owner_user_id, type, category, title, content, summary,
			status, confidence, sensitivity, scope_type, external_use_policy,
			source_mode, created_by_type, created_by_id
		) VALUES (
			$1, $2, 'rule', 'support', '退款回复审批规则',
			'涉及退款的对外回复必须说明已收到并承诺继续跟进。',
			'退款回复需要谨慎且可审批', 'active', 0.92, 'normal', 'workspace',
			'with_approval', 'manual', 'member', $2
		)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&memoryID); err != nil {
		t.Fatalf("insert memory: %v", err)
	}

	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM inbox_item WHERE issue_id = $1 OR details->>'message_id' = 'om_ai_me_e2e_reply'`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE issue_id = $1 OR source_ref_id = 'om_ai_me_e2e_reply'`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM memory_usage WHERE memory_id = $1`, memoryID)
		_, _ = testPool.Exec(ctx, `DELETE FROM memory_entry WHERE id = $1`, memoryID)
		_, _ = testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issue.ID)
	})

	origModel := testHandler.AIModel
	t.Cleanup(func() { testHandler.AIModel = origModel })

	testHandler.AIModel = fakeAIMeModelClient{content: `{
		"summary":"需要分派员工处理退款升级",
		"risk_level":"medium",
		"confidence":0.88,
		"need_approval":false,
		"reasoning_summary":"退款升级需要员工核查订单和日志。",
		"actions":[{"type":"assign_worker","title":"分配给测试员工","description":"请员工核查退款链路并更新进展","issue_id":"` + issue.ID + `","target_agent_id":"` + agentID + `","target_agent_name":"Handler Test Agent","priority":"high","requires_approval":false}],
		"evidence":[{"type":"issue","label":"退款升级 issue","ref_id":"` + issue.ID + `"}]
	}`}
	assignResp := callThinkAIMeForTest(t, member, AIMeThinkRequest{
		Input:       "请判断这个退款升级问题应该交给谁处理",
		Intent:      "assign",
		SourceType:  "issue",
		SourceRefID: issue.ID,
		IssueID:     issue.ID,
	})
	if !assignResp.NeedApproval || assignResp.ApprovalID == "" {
		t.Fatalf("expected assignment approval, got %#v", assignResp)
	}
	assignApproval := approveAIApprovalForTest(t, member, assignResp.ApprovalID, AIApprovalTransitionRequest{Note: "同意派工"})
	if assignApproval.ExecutionStatus != "succeeded" || assignApproval.CreatedTaskID == nil {
		t.Fatalf("assignment approval did not queue task: %#v", assignApproval)
	}

	var assigneeType, assigneeID string
	if err := testPool.QueryRow(ctx, `SELECT assignee_type, assignee_id FROM issue WHERE id = $1`, issue.ID).Scan(&assigneeType, &assigneeID); err != nil {
		t.Fatalf("load assigned issue: %v", err)
	}
	if assigneeType != "agent" || assigneeID != agentID {
		t.Fatalf("issue assignee = %s:%s, want agent:%s", assigneeType, assigneeID, agentID)
	}
	assertAIApprovalEventForTest(t, assignResp.ApprovalID, "execution_succeeded")
	assertIssueActivityForTest(t, issue.ID, "assignee_changed", assignResp.ApprovalID)

	feishuBaseURL, replyText := startFakeFeishuServerForTest(t)
	origFeishu := testHandler.Feishu
	testHandler.Feishu = feishu.NewClient(feishu.Config{
		AppID:     "cli_aime_e2e",
		AppSecret: "test-secret",
		BaseURL:   feishuBaseURL,
	})
	t.Cleanup(func() { testHandler.Feishu = origFeishu })

	testHandler.AIModel = fakeAIMeModelClient{content: `{
		"summary":"需要回复同事说明处理进度",
		"risk_level":"medium",
		"confidence":0.9,
		"need_approval":false,
		"reply_draft":"您好，退款问题我已经收到，会继续跟进处理。",
		"reasoning_summary":"根据长期记忆，退款回复需要谨慎表达并审批后发送。",
		"actions":[{"type":"send_external_message","title":"发送飞书回复","description":"批准后回复飞书原消息","requires_approval":false}],
		"evidence":[{"type":"memory","label":"退款回复审批规则","ref_id":"` + memoryID + `","quote":"涉及退款的对外回复必须说明已收到并承诺继续跟进。"},{"type":"issue","label":"关联 issue","ref_id":"` + issue.ID + `"}]
	}`}
	replyResp := callThinkAIMeForTest(t, member, AIMeThinkRequest{
		Input:       "请回复同事：退款现在是什么状态？",
		Intent:      "reply",
		SourceType:  "feishu",
		SourceRefID: "om_ai_me_e2e_reply",
		IssueID:     issue.ID,
	})
	if !replyResp.NeedApproval || replyResp.ApprovalID == "" {
		t.Fatalf("expected external reply approval, got %#v", replyResp)
	}
	assertMemoryUsageForTest(t, memoryID, issue.ID)

	editedPayload := json.RawMessage(`{"channel":"feishu","message_id":"om_ai_me_e2e_reply","text":"您好，退款问题我已经收到，正在继续跟进处理，稍后同步进展。"}`)
	replyApproval := approveAIApprovalForTest(t, member, replyResp.ApprovalID, AIApprovalTransitionRequest{
		Note:         "编辑后发送",
		FinalPayload: &editedPayload,
	})
	if replyApproval.ExecutionStatus != "succeeded" {
		t.Fatalf("reply approval execution = %#v", replyApproval)
	}
	if got := replyText(); !strings.Contains(got, "稍后同步进展") {
		t.Fatalf("feishu reply text = %q", got)
	}
	assertAIApprovalEventForTest(t, replyResp.ApprovalID, "execution_succeeded")
	assertIssueActivityForTest(t, issue.ID, "ai_me_approval_approved", replyResp.ApprovalID)
}

func callThinkAIMeForTest(t *testing.T, member db.Member, body AIMeThinkRequest) AIMeThinkResponse {
	t.Helper()
	req := newRequest("POST", "/api/ai-me/think?workspace_id="+testWorkspaceID, body)
	req = req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, member))
	w := httptest.NewRecorder()
	testHandler.ThinkAIMe(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ThinkAIMe: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp AIMeThinkResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode ThinkAIMe: %v", err)
	}
	return resp
}

func approveAIApprovalForTest(t *testing.T, member db.Member, approvalID string, body AIApprovalTransitionRequest) AIApprovalResponse {
	t.Helper()
	req := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approvalID+"/approve?workspace_id="+testWorkspaceID, body),
		"id",
		approvalID,
	)
	req = req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, member))
	w := httptest.NewRecorder()
	testHandler.ApproveAIApproval(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ApproveAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode approval: %v", err)
	}
	return resp
}

func startFakeFeishuServerForTest(t *testing.T) (string, func() string) {
	t.Helper()
	var mu sync.Mutex
	var sentText string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/auth/v3/tenant_access_token/internal":
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok","tenant_access_token":"tenant-token","expire":3600}`))
		case r.URL.Path == "/im/v1/messages/om_ai_me_e2e_reply/reply":
			var body struct {
				Content string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode feishu reply body: %v", err)
			}
			var content struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal([]byte(body.Content), &content); err != nil {
				t.Fatalf("decode feishu reply content: %v", err)
			}
			mu.Lock()
			sentText = content.Text
			mu.Unlock()
			_, _ = w.Write([]byte(`{"code":0,"msg":"ok","data":{"message_id":"om_reply_sent"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server.URL, func() string {
		mu.Lock()
		defer mu.Unlock()
		return sentText
	}
}

func assertAIApprovalEventForTest(t *testing.T, approvalID, eventType string) {
	t.Helper()
	var count int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*)
		FROM ai_me_approval_event
		WHERE approval_id = $1 AND event_type = $2
	`, approvalID, eventType).Scan(&count); err != nil {
		t.Fatalf("count approval event: %v", err)
	}
	if count == 0 {
		t.Fatalf("expected approval event %s for %s", eventType, approvalID)
	}
}

func assertIssueActivityForTest(t *testing.T, issueID, action, approvalID string) {
	t.Helper()
	var count int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*)
		FROM activity_log
		WHERE issue_id = $1
		  AND action = $2
		  AND details->>'approval_id' = $3
	`, issueID, action, approvalID).Scan(&count); err != nil {
		t.Fatalf("count issue activity: %v", err)
	}
	if count == 0 {
		t.Fatalf("expected activity %s for issue %s approval %s", action, issueID, approvalID)
	}
}

func assertMemoryUsageForTest(t *testing.T, memoryID, issueID string) {
	t.Helper()
	var count int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*)
		FROM memory_usage
		WHERE memory_id = $1
		  AND issue_id = $2
		  AND action = 'ai_me_think'
	`, memoryID, issueID).Scan(&count); err != nil {
		t.Fatalf("count memory usage: %v", err)
	}
	if count == 0 {
		t.Fatalf("expected AI-Me memory usage for memory %s issue %s", memoryID, issueID)
	}
}
