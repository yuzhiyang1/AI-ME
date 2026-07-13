package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type scriptedToolCallingAIMeModel struct {
	completions []AIModelCompletion
}

func (m *scriptedToolCallingAIMeModel) Configured() bool { return true }
func (m *scriptedToolCallingAIMeModel) Provider() string { return "deepseek" }
func (m *scriptedToolCallingAIMeModel) Model() string    { return "deepseek-test" }
func (m *scriptedToolCallingAIMeModel) Complete(context.Context, string, string) (string, error) {
	return m.completions[0].Content, nil
}
func (m *scriptedToolCallingAIMeModel) CompleteWithTools(_ context.Context, _ []AIModelMessage, _ []AIModelToolDefinition, _ AIModelOptions) (AIModelCompletion, error) {
	completion := m.completions[0]
	m.completions = m.completions[1:]
	return completion, nil
}

func TestThinkAIMeToolCallCreatesDurableRunIssueAndTask(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var originalSettings []byte
	if err := testPool.QueryRow(ctx, `SELECT settings FROM workspace WHERE id = $1`, testWorkspaceID).Scan(&originalSettings); err != nil {
		t.Fatalf("load workspace settings: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE workspace
		SET settings = '{"ai_me":{"enabled":true,"autonomy_level":"autonomous","approval_mode":"never","timezone":"Asia/Shanghai","working_hours":{"start":"00:00","end":"23:59"},"model_provider":"deepseek","model_name":"deepseek-test"}}'::jsonb
		WHERE id = $1
	`, testWorkspaceID); err != nil {
		t.Fatalf("enable autonomous AI-Me: %v", err)
	}
	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent
		WHERE workspace_id = $1 AND name = 'Handler Test Agent'
		ORDER BY created_at ASC LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load test agent: %v", err)
	}

	model := &scriptedToolCallingAIMeModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{{
			ID: "call-durable-create-issue", Type: "function",
			Function: AIModelToolCallFunction{Name: "create_issue", Arguments: `{"title":"核查真实退款进度","description":"检查退款状态并在 Issue 中记录证据。","priority":"high","target_agent_id":"` + agentID + `","summary":"核查退款状态"}`},
		}}}, Usage: AIModelUsage{InputTokens: 100, OutputTokens: 20}},
		{Content: "工具调用已完成。\n\n```json\n{\"summary\":\"已创建并分配退款核查工作项。\",\"risk_level\":\"medium\",\"confidence\":0.9,\"need_approval\":false,\"reply_draft\":\"\",\"reasoning_summary\":\"实际工作已进入 Issue。\",\"actions\":[],\"evidence\":[]}\n```", Message: AIModelMessage{Role: "assistant", Content: "工具调用已完成。\n\n```json\n{\"summary\":\"已创建并分配退款核查工作项。\",\"risk_level\":\"medium\",\"confidence\":0.9,\"need_approval\":false,\"reply_draft\":\"\",\"reasoning_summary\":\"实际工作已进入 Issue。\",\"actions\":[],\"evidence\":[]}\n```"}, Usage: AIModelUsage{InputTokens: 60, OutputTokens: 30}},
	}}
	originalModel := testHandler.AIModel
	testHandler.AIModel = model
	t.Cleanup(func() {
		testHandler.AIModel = originalModel
		_, _ = testPool.Exec(ctx, `UPDATE workspace SET settings = $2 WHERE id = $1`, testWorkspaceID, originalSettings)
	})
	sourceRefID := "tool-runtime-e2e-" + randomID()

	member, err := testHandler.getWorkspaceMember(ctx, testUserID, testWorkspaceID)
	if err != nil {
		t.Fatalf("load workspace member: %v", err)
	}
	request := newRequest("POST", "/api/ai-me/think?workspace_id="+testWorkspaceID, AIMeThinkRequest{
		Input:       "同事问退款什么时候处理好，请安排实际核查。",
		Intent:      "feishu_follow_up",
		SourceType:  "manual",
		SourceRefID: sourceRefID,
	})
	request = request.WithContext(middleware.SetMemberContext(request.Context(), testWorkspaceID, member))
	w := httptest.NewRecorder()
	testHandler.ThinkAIMe(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("ThinkAIMe: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var response AIMeThinkResponse
	if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
		t.Fatalf("decode ThinkAIMe response: %v", err)
	}
	if response.Summary != "已创建并分配退款核查工作项。" {
		t.Fatalf("summary = %q", response.Summary)
	}

	run, err := testHandler.Queries.FindAIMeRunByIdempotencyKey(ctx, db.FindAIMeRunByIdempotencyKeyParams{
		WorkspaceID:    parseUUID(testWorkspaceID),
		IdempotencyKey: "manual:" + sourceRefID,
	})
	if err != nil {
		t.Fatalf("load durable run: %v", err)
	}
	calls, err := testHandler.Queries.ListAIMeToolCalls(ctx, db.ListAIMeToolCallsParams{RunID: run.ID, WorkspaceID: run.WorkspaceID})
	if err != nil || len(calls) != 1 {
		t.Fatalf("tool calls = %#v, err = %v", calls, err)
	}
	call := calls[0]
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE tool_call_id = $1`, call.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, run.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, call.CreatedTaskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, call.CreatedIssueID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, call.CreatedIssueID)
	})
	if run.Status != "succeeded" || call.Status != "succeeded" || !call.CreatedIssueID.Valid || !call.CreatedTaskID.Valid {
		t.Fatalf("run=%s call=%s behavior=%s error=%q result=%s issue=%v task=%v", run.Status, call.Status, call.ApprovalBehavior, call.Error, string(call.Result), call.CreatedIssueID.Valid, call.CreatedTaskID.Valid)
	}
	var finalOutput map[string]any
	if err := json.Unmarshal(run.FinalOutput, &finalOutput); err != nil {
		t.Fatalf("decode final output: %v", err)
	}
	if finalOutput["summary"] != "已创建并分配退款核查工作项。" {
		t.Fatalf("final output = %s", string(run.FinalOutput))
	}
	var approvalExecutionStatus string
	if err := testPool.QueryRow(ctx, `
		SELECT execution_status FROM ai_me_approval
		WHERE workspace_id = $1 AND tool_call_id = $2
	`, testWorkspaceID, call.ID).Scan(&approvalExecutionStatus); err != nil || approvalExecutionStatus != "succeeded" {
		t.Fatalf("linked approval execution = %q, err = %v", approvalExecutionStatus, err)
	}
	issue, err := testHandler.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: call.CreatedIssueID, WorkspaceID: run.WorkspaceID})
	if err != nil || issue.Title != "核查真实退款进度" || issue.AssigneeID != parseUUID(agentID) || issue.OriginType.String != "ai_me" || issue.OriginID != call.ID {
		t.Fatalf("created issue = %#v, err = %v", issue, err)
	}
}

func TestThinkAIMeToolCallWaitsForApprovalThenCreatesIssue(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var originalSettings []byte
	if err := testPool.QueryRow(ctx, `SELECT settings FROM workspace WHERE id = $1`, testWorkspaceID).Scan(&originalSettings); err != nil {
		t.Fatalf("load workspace settings: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE workspace
		SET settings = '{"ai_me":{"enabled":true,"autonomy_level":"balanced","approval_mode":"always","timezone":"Asia/Shanghai","working_hours":{"start":"00:00","end":"23:59"},"model_provider":"deepseek","model_name":"deepseek-test"}}'::jsonb
		WHERE id = $1
	`, testWorkspaceID); err != nil {
		t.Fatalf("enable approval-gated AI-Me: %v", err)
	}
	model := &scriptedToolCallingAIMeModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{{
			ID: "call-approval-create-issue", Type: "function",
			Function: AIModelToolCallFunction{Name: "create_issue", Arguments: `{"title":"等待审批的真实工作项","description":"批准后创建。","priority":"medium"}`},
		}}}},
		{Content: `{"summary":"创建工作项正在等待审批。","risk_level":"medium","confidence":0.9,"need_approval":true,"reply_draft":"","reasoning_summary":"内部写操作受当前审批策略约束。","actions":[],"evidence":[]}`, Message: AIModelMessage{Role: "assistant", Content: `{"summary":"创建工作项正在等待审批。","risk_level":"medium","confidence":0.9,"need_approval":true,"reply_draft":"","reasoning_summary":"内部写操作受当前审批策略约束。","actions":[],"evidence":[]}`}},
	}}
	originalModel := testHandler.AIModel
	testHandler.AIModel = model
	t.Cleanup(func() {
		testHandler.AIModel = originalModel
		_, _ = testPool.Exec(ctx, `UPDATE workspace SET settings = $2 WHERE id = $1`, testWorkspaceID, originalSettings)
	})
	member, err := testHandler.getWorkspaceMember(ctx, testUserID, testWorkspaceID)
	if err != nil {
		t.Fatalf("load workspace member: %v", err)
	}
	sourceRefID := "tool-runtime-approval-" + randomID()
	request := newRequest("POST", "/api/ai-me/think?workspace_id="+testWorkspaceID, AIMeThinkRequest{
		Input: "请创建一个需要审批的工作项。", SourceType: "manual", SourceRefID: sourceRefID,
	})
	request = request.WithContext(middleware.SetMemberContext(request.Context(), testWorkspaceID, member))
	w := httptest.NewRecorder()
	testHandler.ThinkAIMe(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("ThinkAIMe: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	run, err := testHandler.Queries.FindAIMeRunByIdempotencyKey(ctx, db.FindAIMeRunByIdempotencyKeyParams{WorkspaceID: parseUUID(testWorkspaceID), IdempotencyKey: "manual:" + sourceRefID})
	if err != nil {
		t.Fatalf("load waiting run: %v", err)
	}
	calls, err := testHandler.Queries.ListAIMeToolCalls(ctx, db.ListAIMeToolCallsParams{RunID: run.ID, WorkspaceID: run.WorkspaceID})
	if err != nil || len(calls) != 1 {
		t.Fatalf("tool calls = %#v, err = %v", calls, err)
	}
	call := calls[0]
	var approvalID string
	if err := testPool.QueryRow(ctx, `SELECT id FROM ai_me_approval WHERE tool_call_id = $1`, call.ID).Scan(&approvalID); err != nil {
		t.Fatalf("load linked approval: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, run.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, call.CreatedIssueID)
		_, _ = testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, call.CreatedIssueID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, call.CreatedIssueID)
	})
	if run.Status != "waiting_approval" || call.Status != "waiting_approval" {
		t.Fatalf("before approval run=%s call=%s", run.Status, call.Status)
	}

	approveReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approvalID+"/approve?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Note: "批准创建工作项"}),
		"id",
		approvalID,
	)
	w = httptest.NewRecorder()
	testHandler.ApproveAIApproval(w, approveReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ApproveAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var approved AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approved); err != nil {
		t.Fatalf("decode approved response: %v", err)
	}
	if approved.ExecutionStatus != "succeeded" || approved.CreatedIssueID == nil {
		t.Fatalf("approved execution=%s issue=%#v", approved.ExecutionStatus, approved.CreatedIssueID)
	}
	call.CreatedIssueID = parseUUID(*approved.CreatedIssueID)

	run, err = testHandler.Queries.GetAIMeRun(ctx, db.GetAIMeRunParams{ID: run.ID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		t.Fatalf("reload run: %v", err)
	}
	calls, err = testHandler.Queries.ListAIMeToolCalls(ctx, db.ListAIMeToolCallsParams{RunID: run.ID, WorkspaceID: run.WorkspaceID})
	if err != nil || len(calls) != 1 {
		t.Fatalf("reload tool calls = %#v, err = %v", calls, err)
	}
	if run.Status != "succeeded" || calls[0].Status != "succeeded" || !calls[0].CreatedIssueID.Valid {
		t.Fatalf("after approval run=%s call=%s issue=%v", run.Status, calls[0].Status, calls[0].CreatedIssueID.Valid)
	}
}

func TestRejectToolApprovalMarksRunAndCallRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	workspaceID := parseUUID(testWorkspaceID)
	userID := parseUUID(testUserID)
	run, err := testHandler.Queries.CreateAIMeRun(ctx, db.CreateAIMeRunParams{
		WorkspaceID: workspaceID, UserID: userID, Source: "manual",
		Input: []byte(`{"text":"reject test"}`), ContextSnapshot: []byte(`{}`), PolicySnapshot: []byte(`{}`),
		Provider: "fake", Model: "fake", MaxSteps: 6, IdempotencyKey: "reject-test-" + randomID(),
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	run, err = testHandler.Queries.StartSpecificAIMeRun(ctx, db.StartSpecificAIMeRunParams{
		LeaseOwner: "reject-test", LeaseSeconds: 120, ID: run.ID, WorkspaceID: workspaceID,
	})
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	call, err := testHandler.Queries.CreateAIMeToolCall(ctx, db.CreateAIMeToolCallParams{
		RunID: run.ID, ProviderCallID: "call-reject", ToolName: "create_issue", Arguments: []byte(`{"title":"不要创建"}`),
		RiskLevel: "medium", ApprovalBehavior: "requires_approval", IdempotencyKey: "call-reject", WorkspaceID: workspaceID,
	})
	if err != nil {
		t.Fatalf("create tool call: %v", err)
	}
	confidence := 0.8
	params, err := createAIMeApprovalParams(workspaceID, userID, CreateAIApprovalRequest{
		SourceType: "manual", SourceRefID: "reject-tool-approval", Title: "不要创建",
		Summary: "等待用户确认。", RiskLevel: "medium", Confidence: &confidence,
		Reversibility: "reversible", ActionType: "create_issue", ActionTitle: "创建 Issue",
		ActionDescription: "批准后创建。", OriginalPayload: map[string]any{"title": "不要创建"}, FinalPayload: map[string]any{"title": "不要创建"},
	})
	if err != nil {
		t.Fatalf("build approval params: %v", err)
	}
	params.ToolCallID = call.ID
	approval, err := testHandler.createAIMeApproval(ctx, testWorkspaceID, testUserID, params, nil)
	if err != nil {
		t.Fatalf("create approval: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approval.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, run.ID)
	})

	rejectReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+uuidToString(approval.ID)+"/reject?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Reason: "不需要创建这个工作项"}),
		"id",
		uuidToString(approval.ID),
	)
	w := httptest.NewRecorder()
	testHandler.RejectAIApproval(w, rejectReq)
	if w.Code != http.StatusOK {
		t.Fatalf("RejectAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	run, err = testHandler.Queries.GetAIMeRun(ctx, db.GetAIMeRunParams{ID: run.ID, WorkspaceID: workspaceID})
	if err != nil {
		t.Fatalf("reload rejected run: %v", err)
	}
	call, err = testHandler.Queries.GetAIMeToolCall(ctx, db.GetAIMeToolCallParams{ID: call.ID, WorkspaceID: workspaceID})
	if err != nil {
		t.Fatalf("reload rejected call: %v", err)
	}
	if run.Status != "rejected" || call.Status != "rejected" {
		t.Fatalf("run=%s call=%s, want rejected/rejected", run.Status, call.Status)
	}
}
