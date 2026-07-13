package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type scriptedToolCallingAIMeModel struct {
	completions []AIModelCompletion
}

type failingToolCallingAIMeModel struct {
	calls int
}

func TestTaskCompletedEnqueuesSingleAIMeContinuation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent
		WHERE workspace_id = $1
		ORDER BY created_at ASC
		LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load agent: %v", err)
	}
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, description, status, priority,
			assignee_type, assignee_id, creator_type, creator_id
		)
		VALUES ($1, 'AI-Me continuation test', '', 'in_review', 'medium', 'agent', $2, 'member', $3)
		RETURNING id
	`, testWorkspaceID, agentID, testUserID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, result, completed_at)
		VALUES ($1, $2, $3, 'completed', '{"output":"Tool Calling review complete"}'::jsonb, now())
		RETURNING id
	`, agentID, issueID, testRuntimeID).Scan(&taskID); err != nil {
		t.Fatalf("create task: %v", err)
	}
	var approvalID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, source_ref_id,
			title, summary, risk_level, confidence, reversibility,
			action_type, action_title, action_description,
			original_payload, final_payload, ai_reasoning_summary
		)
		VALUES (
			$1, $2, 'feishu', $3::text,
			'是否回复这条飞书消息', '员工正在处理', 'high', 0.8, 'irreversible',
			'send_external_message', '回复飞书消息', '批准后回复原消息',
			jsonb_build_object('incoming_text', '检查续跑深度'),
			jsonb_build_object('text', '正在处理。', 'channel', 'feishu', 'message_id', $3::text),
			'已创建工作项并交给员工'
		)
		RETURNING id
	`, testWorkspaceID, testUserID, "message-depth-limit-"+randomID()).Scan(&approvalID); err != nil {
		t.Fatalf("create approval: %v", err)
	}
	var runID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, status, input, context_snapshot,
			policy_snapshot, provider, model, idempotency_key, completed_at
		)
		VALUES (
			$1, $2, 'feishu', 'succeeded',
			jsonb_build_object(
				'approval_id', $4::text,
				'item_id', gen_random_uuid()::text,
				'depth', $5::int
			),
			'{}'::jsonb, '{}'::jsonb, 'deepseek', 'deepseek-test', $3, now()
		)
		RETURNING id
	`, testWorkspaceID, testUserID, "feishu:continuation-test-"+randomID(), approvalID, aiMeMaxContinuationDepth).Scan(&runID); err != nil {
		t.Fatalf("create AI-Me run: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO ai_me_tool_call (
			run_id, provider_call_id, tool_name, arguments, status,
			risk_level, approval_behavior, result, created_issue_id,
			created_task_id, idempotency_key, completed_at
		)
		VALUES (
			$1, 'call-continuation', 'create_issue', '{}'::jsonb, 'succeeded',
			'medium', 'auto_execute', '{}'::jsonb, $2, $3, $4, now()
		)
	`, runID, issueID, taskID, "call:"+randomID()); err != nil {
		t.Fatalf("create AI-Me tool call: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE workspace_id = $1 AND idempotency_key = $2`, testWorkspaceID, "task_result:"+taskID+":completed")
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, runID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})

	event := events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: testWorkspaceID,
		ActorType:   "system",
		Payload: map[string]any{
			"task_id":  taskID,
			"issue_id": issueID,
			"status":   "completed",
		},
	}
	testHandler.processDueAIMeRuns(ctx)
	var recoveredCount int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM ai_me_run
		WHERE workspace_id = $1 AND idempotency_key = $2
	`, testWorkspaceID, "task_result:"+taskID+":completed").Scan(&recoveredCount); err != nil {
		t.Fatalf("load recovered continuation run: %v", err)
	}
	if recoveredCount != 1 {
		t.Fatalf("recovered continuation run count = %d, want 1", recoveredCount)
	}
	testHandler.Bus.Publish(event)
	testHandler.Bus.Publish(event)

	var count int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM ai_me_run
		WHERE workspace_id = $1 AND idempotency_key = $2
	`, testWorkspaceID, "task_result:"+taskID+":completed").Scan(&count); err != nil {
		t.Fatalf("load continuation run: %v", err)
	}
	if count != 1 {
		t.Fatalf("continuation run count = %d, want 1", count)
	}
	var source string
	var input []byte
	if err := testPool.QueryRow(ctx, `
		SELECT source, input
		FROM ai_me_run
		WHERE workspace_id = $1 AND idempotency_key = $2
	`, testWorkspaceID, "task_result:"+taskID+":completed").Scan(&source, &input); err != nil {
		t.Fatalf("load continuation run details: %v", err)
	}
	if source != "task_result" {
		t.Fatalf("continuation source = %q, want task_result", source)
	}
	var runInput map[string]any
	if err := json.Unmarshal(input, &runInput); err != nil {
		t.Fatalf("decode continuation input: %v", err)
	}
	if runInput["task_id"] != taskID || runInput["task_status"] != "completed" || runInput["parent_run_id"] != runID {
		t.Fatalf("continuation input = %#v", runInput)
	}
	if intFromJSON(runInput["depth"]) != aiMeMaxContinuationDepth+1 {
		t.Fatalf("continuation depth = %v, want %d", runInput["depth"], aiMeMaxContinuationDepth+1)
	}
	var awaiting bool
	var replyText string
	if err := testPool.QueryRow(ctx, `
		SELECT COALESCE((final_payload->>'awaiting_task_result')::boolean, false), final_payload->>'text'
		FROM ai_me_approval
		WHERE id = $1
	`, approvalID).Scan(&awaiting, &replyText); err != nil {
		t.Fatalf("load depth-limited approval: %v", err)
	}
	if awaiting {
		t.Fatal("depth-limited approval should be ready for human review")
	}
	if !strings.Contains(replyText, "系统已停止继续调用员工") {
		t.Fatalf("depth-limited reply = %q", replyText)
	}
}

func TestTaskCompletedContinuationUpdatesPendingFeishuReply(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load agent: %v", err)
	}
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, description, status, priority,
			assignee_type, assignee_id, creator_type, creator_id
		)
		VALUES ($1, 'Review Tool Calling coverage', 'Inspect the current test matrix.', 'in_review', 'medium', 'agent', $2, 'member', $3)
		RETURNING id
	`, testWorkspaceID, agentID, testUserID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (
			agent_id, issue_id, runtime_id, status, result, started_at, completed_at
		)
		VALUES (
			$1, $2, $3, 'completed',
			'{"output":"28 targeted Tool Calling tests passed; Gemini, Pi, Cursor and the end-to-end transcript still need coverage."}'::jsonb,
			now() - interval '2 minutes', now()
		)
		RETURNING id
	`, agentID, issueID, testRuntimeID).Scan(&taskID); err != nil {
		t.Fatalf("create task: %v", err)
	}
	var approvalID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, source_ref_id,
			title, summary, risk_level, confidence, reversibility,
			action_type, action_title, action_description,
			original_payload, final_payload, ai_reasoning_summary
		)
		VALUES (
			$1, $2, 'feishu', $3::text,
			'是否回复这条飞书消息', '员工正在处理', 'high', 0.8, 'irreversible',
			'send_external_message', '回复飞书消息', '批准后回复原消息',
			jsonb_build_object('incoming_text', '检查 Tool Calling 测试完整性'),
			jsonb_build_object(
				'text', '已创建工作项，正在等待员工处理。',
				'channel', 'feishu',
				'message_id', $3::text,
				'draft_source', 'ai_model'
			),
			'已创建工作项并交给员工'
		)
		RETURNING id
	`, testWorkspaceID, testUserID, "message-continuation-"+randomID()).Scan(&approvalID); err != nil {
		t.Fatalf("create approval: %v", err)
	}
	var parentRunID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, status, input, context_snapshot,
			policy_snapshot, provider, model, idempotency_key, completed_at
		)
		VALUES (
			$1, $2, 'feishu', 'succeeded',
			jsonb_build_object(
				'approval_id', $3::text,
				'message_text', '检查 Tool Calling 测试完整性并交给 Codex 处理',
				'payload', jsonb_build_object(),
				'gate', jsonb_build_object()
			),
			'{}'::jsonb, '{}'::jsonb, 'deepseek', 'deepseek-test', $4::text, now()
		)
		RETURNING id
	`, testWorkspaceID, testUserID, approvalID, "feishu:result-test-"+randomID()).Scan(&parentRunID); err != nil {
		t.Fatalf("create parent run: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO ai_me_tool_call (
			run_id, provider_call_id, tool_name, arguments, status,
			risk_level, approval_behavior, result, created_issue_id,
			created_task_id, idempotency_key, completed_at
		)
		VALUES (
			$1, 'call-result', 'create_issue', '{}'::jsonb, 'succeeded',
			'medium', 'auto_execute', '{}'::jsonb, $2, $3, $4, now()
		)
	`, parentRunID, issueID, taskID, "call:"+randomID()); err != nil {
		t.Fatalf("create tool call: %v", err)
	}
	seedApproval, err := testHandler.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{
		ID: parseUUID(approvalID), WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load seeded approval: %v", err)
	}
	seedRun, err := testHandler.Queries.GetAIMeRun(ctx, db.GetAIMeRunParams{
		ID: parseUUID(parentRunID), WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load seeded run: %v", err)
	}
	linkedApproval, err := testHandler.markFeishuApprovalWaitingForLatestRunTask(ctx, seedApproval, seedRun)
	if err != nil {
		t.Fatalf("link approval to initial employee task: %v", err)
	}
	linkedPayload := approvalPayloadMap(linkedApproval.FinalPayload)
	if waiting, _ := linkedPayload["awaiting_task_result"].(bool); !waiting {
		t.Fatal("approval should wait as soon as the initial employee task is created")
	}
	if stringFromJSON(linkedPayload["task_id"]) != taskID {
		t.Fatalf("linked task id = %q, want %q", stringFromJSON(linkedPayload["task_id"]), taskID)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE workspace_id = $1 AND idempotency_key = $2`, testWorkspaceID, "task_result:"+taskID+":completed")
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, parentRunID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})

	model := &scriptedToolCallingAIMeModel{completions: []AIModelCompletion{{
		Content: `{"summary":"Codex 已完成 Tool Calling 测试审查。","risk_level":"medium","confidence":0.95,"need_approval":true,"reply_draft":"已完成 Tool Calling 测试审查：现有 28 个定向用例通过，主要缺口是 Gemini、Pi、Cursor 和端到端链路。","reasoning_summary":"根据员工任务结果生成最终回复。","actions":[],"evidence":[]}`,
		Message: AIModelMessage{Role: "assistant", Content: `{"summary":"Codex 已完成 Tool Calling 测试审查。","risk_level":"medium","confidence":0.95,"need_approval":true,"reply_draft":"已完成 Tool Calling 测试审查：现有 28 个定向用例通过，主要缺口是 Gemini、Pi、Cursor 和端到端链路。","reasoning_summary":"根据员工任务结果生成最终回复。","actions":[],"evidence":[]}`},
		Usage:   AIModelUsage{InputTokens: 120, OutputTokens: 45},
	}}}
	originalModel := testHandler.AIModel
	testHandler.AIModel = model
	t.Cleanup(func() { testHandler.AIModel = originalModel })

	testHandler.Bus.Publish(events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: testWorkspaceID,
		ActorType:   "system",
		Payload: map[string]any{
			"task_id":  taskID,
			"issue_id": issueID,
			"status":   "completed",
		},
	})
	testHandler.processDueAIMeRuns(ctx)

	var status, replyText, summary string
	var awaiting bool
	if err := testPool.QueryRow(ctx, `
		SELECT status, final_payload->>'text', summary,
		       COALESCE((final_payload->>'awaiting_task_result')::boolean, false)
		FROM ai_me_approval
		WHERE id = $1
	`, approvalID).Scan(&status, &replyText, &summary, &awaiting); err != nil {
		t.Fatalf("load updated approval: %v", err)
	}
	if status != "pending" {
		t.Fatalf("approval status = %q, want pending", status)
	}
	if awaiting {
		t.Fatal("approval should be ready for final review")
	}
	if replyText != "已完成 Tool Calling 测试审查：现有 28 个定向用例通过，主要缺口是 Gemini、Pi、Cursor 和端到端链路。" {
		t.Fatalf("reply text = %q", replyText)
	}
	if summary != "Codex 已完成 Tool Calling 测试审查。" {
		t.Fatalf("summary = %q", summary)
	}
	var waitingEvents, readyEvents int
	if err := testPool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE payload->>'kind' = 'task_result_waiting'),
			count(*) FILTER (WHERE payload->>'kind' = 'task_result_ready')
		FROM ai_me_approval_event
		WHERE approval_id = $1
	`, approvalID).Scan(&waitingEvents, &readyEvents); err != nil {
		t.Fatalf("load continuation events: %v", err)
	}
	if waitingEvents != 1 || readyEvents != 1 {
		t.Fatalf("continuation events waiting=%d ready=%d, want 1 each", waitingEvents, readyEvents)
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE ai_me_approval
		SET final_payload = jsonb_set(final_payload, '{awaiting_task_result}', 'true'::jsonb),
		    updated_at = now()
		WHERE id = $1
	`, approvalID); err != nil {
		t.Fatalf("simulate incomplete approval finalization: %v", err)
	}
	testHandler.processDueAIMeRuns(ctx)
	if err := testPool.QueryRow(ctx, `
		SELECT COALESCE((final_payload->>'awaiting_task_result')::boolean, false)
		FROM ai_me_approval WHERE id = $1
	`, approvalID).Scan(&awaiting); err != nil {
		t.Fatalf("load recovered approval: %v", err)
	}
	if awaiting {
		t.Fatal("scheduler should recover a succeeded run with incomplete approval finalization")
	}
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) FROM ai_me_approval_event
		WHERE approval_id = $1 AND payload->>'kind' = 'task_result_ready'
	`, approvalID).Scan(&readyEvents); err != nil {
		t.Fatalf("load recovered ready event: %v", err)
	}
	if readyEvents != 2 {
		t.Fatalf("ready events after recovery = %d, want 2", readyEvents)
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE ai_me_approval
		SET final_payload = jsonb_set(
			final_payload,
			'{text}',
			to_jsonb('员工任务已经结束，结果如下：旧的保守草稿'::text)
		), updated_at = now()
		WHERE id = $1
	`, approvalID); err != nil {
		t.Fatalf("simulate fallback draft winning over durable output: %v", err)
	}
	testHandler.processDueAIMeRuns(ctx)
	if err := testPool.QueryRow(ctx, `
		SELECT final_payload->>'text' FROM ai_me_approval WHERE id = $1
	`, approvalID).Scan(&replyText); err != nil {
		t.Fatalf("load repaired reply text: %v", err)
	}
	if replyText != "已完成 Tool Calling 测试审查：现有 28 个定向用例通过，主要缺口是 Gemini、Pi、Cursor 和端到端链路。" {
		t.Fatalf("repaired reply text = %q", replyText)
	}
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) FROM ai_me_approval_event
		WHERE approval_id = $1 AND payload->>'kind' = 'task_result_ready'
	`, approvalID).Scan(&readyEvents); err != nil {
		t.Fatalf("load repaired ready event count: %v", err)
	}
	if readyEvents != 3 {
		t.Fatalf("ready events after draft repair = %d, want 3", readyEvents)
	}
}

func TestFailedTaskContinuationCanReassignAndWaitForNextResult(t *testing.T) {
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
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, description, status, priority,
			assignee_type, assignee_id, creator_type, creator_id
		)
		VALUES ($1, 'Retry failed employee task', 'Retry with a new employee task.', 'in_review', 'high', 'agent', $2, 'member', $3)
		RETURNING id
	`, testWorkspaceID, agentID, testUserID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	var failedTaskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (
			agent_id, issue_id, runtime_id, status, error, failure_reason, started_at, completed_at
		)
		VALUES ($1, $2, $3, 'failed', 'worker process exited', 'runtime_error', now() - interval '1 minute', now())
		RETURNING id
	`, agentID, issueID, testRuntimeID).Scan(&failedTaskID); err != nil {
		t.Fatalf("create failed task: %v", err)
	}
	messageID := "message-reassign-" + randomID()
	var approvalID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, source_ref_id,
			title, summary, risk_level, confidence, reversibility,
			action_type, action_title, action_description,
			original_payload, final_payload, ai_reasoning_summary
		)
		VALUES (
			$1, $2, 'feishu', $3::text,
			'是否回复这条飞书消息', '员工正在处理', 'high', 0.8, 'irreversible',
			'send_external_message', '回复飞书消息', '批准后回复原消息',
			jsonb_build_object('incoming_text', '请重新处理失败任务'),
			jsonb_build_object('text', '正在处理。', 'channel', 'feishu', 'message_id', $3::text),
			'已创建工作项并交给员工'
		)
		RETURNING id
	`, testWorkspaceID, testUserID, messageID).Scan(&approvalID); err != nil {
		t.Fatalf("create approval: %v", err)
	}
	var parentRunID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, status, input, context_snapshot,
			policy_snapshot, provider, model, idempotency_key, completed_at
		)
		VALUES (
			$1, $2, 'feishu', 'succeeded',
			jsonb_build_object('approval_id', $3::text, 'message_text', '请重新处理失败任务'),
			'{}'::jsonb, '{}'::jsonb, 'deepseek', 'deepseek-test', $4, now()
		)
		RETURNING id
	`, testWorkspaceID, testUserID, approvalID, "feishu:reassign-test-"+randomID()).Scan(&parentRunID); err != nil {
		t.Fatalf("create parent run: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO ai_me_tool_call (
			run_id, provider_call_id, tool_name, arguments, status,
			risk_level, approval_behavior, result, created_issue_id,
			created_task_id, idempotency_key, completed_at
		)
		VALUES (
			$1, 'call-failed-task', 'assign_worker', '{}'::jsonb, 'succeeded',
			'medium', 'auto_execute', '{}'::jsonb, $2, $3, $4, now()
		)
	`, parentRunID, issueID, failedTaskID, "call:"+randomID()); err != nil {
		t.Fatalf("create parent tool call: %v", err)
	}

	model := &scriptedToolCallingAIMeModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{{
			ID: "call-reassign-worker", Type: "function",
			Function: AIModelToolCallFunction{Name: "assign_worker", Arguments: `{"issue_id":"` + issueID + `","target_agent_id":"` + agentID + `","priority":"high","summary":"重试失败的员工任务"}`},
		}}}, Usage: AIModelUsage{InputTokens: 100, OutputTokens: 20}},
		{Content: `{"summary":"失败任务已重新分配。","risk_level":"medium","confidence":0.9,"need_approval":true,"reply_draft":"已重新安排员工处理。","reasoning_summary":"第一次执行失败，已创建新的员工任务。","actions":[],"evidence":[]}`, Message: AIModelMessage{Role: "assistant", Content: `{"summary":"失败任务已重新分配。","risk_level":"medium","confidence":0.9,"need_approval":true,"reply_draft":"已重新安排员工处理。","reasoning_summary":"第一次执行失败，已创建新的员工任务。","actions":[],"evidence":[]}`}, Usage: AIModelUsage{InputTokens: 60, OutputTokens: 30}},
	}}
	originalModel := testHandler.AIModel
	testHandler.AIModel = model
	var createdTaskID string
	t.Cleanup(func() {
		testHandler.AIModel = originalModel
		_, _ = testPool.Exec(ctx, `UPDATE workspace SET settings = $2 WHERE id = $1`, testWorkspaceID, originalSettings)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE source_type = 'task_result' AND source_ref_id = $1`, failedTaskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE workspace_id = $1 AND idempotency_key = $2`, testWorkspaceID, "task_result:"+failedTaskID+":failed")
		if createdTaskID != "" {
			_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, createdTaskID)
		}
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, parentRunID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, failedTaskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})

	testHandler.Bus.Publish(events.Event{
		Type: protocol.EventTaskFailed, WorkspaceID: testWorkspaceID, ActorType: "system",
		Payload: map[string]any{"task_id": failedTaskID, "issue_id": issueID, "status": "failed"},
	})
	testHandler.processDueAIMeRuns(ctx)

	var awaiting bool
	if err := testPool.QueryRow(ctx, `
		SELECT created_task_id::text,
		       COALESCE((final_payload->>'awaiting_task_result')::boolean, false)
		FROM ai_me_approval
		WHERE id = $1
	`, approvalID).Scan(&createdTaskID, &awaiting); err != nil {
		t.Fatalf("load reassigned approval: %v", err)
	}
	if !awaiting {
		t.Fatal("approval should keep waiting for the reassigned employee task")
	}
	if createdTaskID == failedTaskID || createdTaskID == "" {
		t.Fatalf("created task id = %q, want a new task", createdTaskID)
	}
	var createdTaskStatus string
	if err := testPool.QueryRow(ctx, `SELECT status FROM agent_task_queue WHERE id = $1`, createdTaskID).Scan(&createdTaskStatus); err != nil {
		t.Fatalf("load reassigned task: %v", err)
	}
	if createdTaskStatus != "queued" {
		t.Fatalf("reassigned task status = %q, want queued", createdTaskStatus)
	}
}

func TestTaskResultFailureRetriesThenUnlocksApproval(t *testing.T) {
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
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, description, status, priority,
			assignee_type, assignee_id, creator_type, creator_id
		)
		VALUES ($1, 'Task result retry test', 'Verify continuation retry compensation.', 'in_review', 'high', 'agent', $2, 'member', $3)
		RETURNING id
	`, testWorkspaceID, agentID, testUserID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, result, started_at, completed_at)
		VALUES ($1, $2, $3, 'completed', '{"output":"Employee result is persisted."}'::jsonb, now() - interval '1 minute', now())
		RETURNING id
	`, agentID, issueID, testRuntimeID).Scan(&taskID); err != nil {
		t.Fatalf("create task: %v", err)
	}
	messageID := "message-retry-" + randomID()
	var approvalID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, source_ref_id,
			issue_id, title, summary, risk_level, confidence, reversibility,
			action_type, action_title, action_description,
			original_payload, final_payload, ai_reasoning_summary,
			created_issue_id, created_task_id
		)
		VALUES (
			$1, $2, 'feishu', $3::text,
			$4::uuid, '是否回复这条飞书消息', '等待员工结果', 'high', 0.8, 'irreversible',
			'send_external_message', '回复飞书消息', '员工完成后回复',
			jsonb_build_object('incoming_text', '检查续跑失败补偿'),
			jsonb_build_object(
				'text', '正在等待员工处理。', 'channel', 'feishu', 'message_id', $3::text,
				'awaiting_task_result', true, 'task_id', $5::text, 'issue_id', $4::text
			),
			'等待员工结果', $4::uuid, $5::uuid
		)
		RETURNING id
	`, testWorkspaceID, testUserID, messageID, issueID, taskID).Scan(&approvalID); err != nil {
		t.Fatalf("create approval: %v", err)
	}
	var runID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, input, context_snapshot,
			policy_snapshot, provider, model, idempotency_key
		)
		VALUES (
			$1, $2, 'task_result',
			jsonb_build_object(
				'task_id', $3::text, 'task_status', 'completed',
				'approval_id', $4::text, 'depth', 1, 'retry_count', 0,
				'original_text', '检查续跑失败补偿'
			),
			'{}'::jsonb, '{}'::jsonb, 'deepseek', 'deepseek-test', $5
		)
		RETURNING id
	`, testWorkspaceID, testUserID, taskID, approvalID, "task_result:"+taskID+":completed").Scan(&runID); err != nil {
		t.Fatalf("create continuation run: %v", err)
	}

	model := &failingToolCallingAIMeModel{}
	originalModel := testHandler.AIModel
	testHandler.AIModel = model
	t.Cleanup(func() {
		testHandler.AIModel = originalModel
		_, _ = testPool.Exec(ctx, `UPDATE workspace SET settings = $2 WHERE id = $1`, testWorkspaceID, originalSettings)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, runID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})

	for attempt := 1; attempt <= 3; attempt++ {
		testHandler.processDueAIMeRuns(ctx)
		var runStatus string
		var retryCount int
		if err := testPool.QueryRow(ctx, `
			SELECT status, COALESCE((input->>'retry_count')::int, 0)
			FROM ai_me_run WHERE id = $1
		`, runID).Scan(&runStatus, &retryCount); err != nil {
			t.Fatalf("load continuation attempt %d: %v", attempt, err)
		}
		if attempt <= 2 {
			if runStatus != "queued" || retryCount != attempt {
				t.Fatalf("attempt %d run status=%q retry_count=%d", attempt, runStatus, retryCount)
			}
			var awaiting bool
			if err := testPool.QueryRow(ctx, `
				SELECT COALESCE((final_payload->>'awaiting_task_result')::boolean, false)
				FROM ai_me_approval WHERE id = $1
			`, approvalID).Scan(&awaiting); err != nil {
				t.Fatalf("load approval attempt %d: %v", attempt, err)
			}
			if !awaiting {
				t.Fatalf("approval unlocked before retry budget was exhausted on attempt %d", attempt)
			}
			_, _ = testPool.Exec(ctx, `UPDATE ai_me_run SET next_wake_at = now() WHERE id = $1`, runID)
			continue
		}
		if runStatus != "failed" || retryCount != 2 {
			t.Fatalf("final run status=%q retry_count=%d, want failed/2", runStatus, retryCount)
		}
	}

	var awaiting bool
	var replyText string
	if err := testPool.QueryRow(ctx, `
		SELECT COALESCE((final_payload->>'awaiting_task_result')::boolean, false), final_payload->>'text'
		FROM ai_me_approval WHERE id = $1
	`, approvalID).Scan(&awaiting, &replyText); err != nil {
		t.Fatalf("load unlocked approval: %v", err)
	}
	if awaiting {
		t.Fatal("approval should unlock after continuation retries are exhausted")
	}
	if !strings.Contains(replyText, "自动复核失败") {
		t.Fatalf("unlocked approval reply = %q", replyText)
	}
	var failureEvents int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) FROM ai_me_approval_event
		WHERE approval_id = $1 AND payload->>'kind' = 'task_result_review_failed'
	`, approvalID).Scan(&failureEvents); err != nil {
		t.Fatalf("load failure event: %v", err)
	}
	if failureEvents != 1 {
		t.Fatalf("failure events = %d, want 1", failureEvents)
	}
	if model.calls != 3 {
		t.Fatalf("model calls = %d, want 3", model.calls)
	}
}

func TestToolApprovalOutcomesSynchronizeOuterFeishuApproval(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load agent: %v", err)
	}

	t.Run("approved tool links the new employee task", func(t *testing.T) {
		issueID, oldTaskID, approvalID := seedToolOutcomeApproval(t, ctx, agentID, "approved")
		var newTaskID string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status)
			VALUES ($1, $2, $3, 'queued') RETURNING id
		`, agentID, issueID, testRuntimeID).Scan(&newTaskID); err != nil {
			t.Fatalf("create new employee task: %v", err)
		}
		runID, callID := seedTerminalToolOutcome(t, ctx, approvalID, oldTaskID, issueID, newTaskID, "succeeded", "")
		t.Cleanup(func() {
			_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
			_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, runID)
			_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id IN ($1, $2)`, oldTaskID, newTaskID)
			_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
		})

		testHandler.processDueAIMeRuns(ctx)
		var awaiting bool
		var linkedTaskID, createdTaskID string
		if err := testPool.QueryRow(ctx, `
			SELECT COALESCE((final_payload->>'awaiting_task_result')::boolean, false),
			       final_payload->>'task_id', created_task_id::text
			FROM ai_me_approval WHERE id = $1
		`, approvalID).Scan(&awaiting, &linkedTaskID, &createdTaskID); err != nil {
			t.Fatalf("load synchronized outer approval: %v", err)
		}
		if !awaiting || linkedTaskID != newTaskID || createdTaskID != newTaskID {
			t.Fatalf("outer approval awaiting=%v task=%q created_task=%q, want new task %q", awaiting, linkedTaskID, createdTaskID, newTaskID)
		}
		var waitingEvents int
		if err := testPool.QueryRow(ctx, `
			SELECT count(*) FROM ai_me_approval_event
			WHERE approval_id = $1 AND payload->>'kind' = 'task_result_waiting'
		`, approvalID).Scan(&waitingEvents); err != nil {
			t.Fatalf("load waiting event: %v", err)
		}
		if waitingEvents != 1 {
			t.Fatalf("waiting events = %d, want 1 for tool call %s", waitingEvents, callID)
		}
	})

	t.Run("rejected tool unlocks the outer approval for human review", func(t *testing.T) {
		issueID, oldTaskID, approvalID := seedToolOutcomeApproval(t, ctx, agentID, "rejected")
		runID, callID := seedTerminalToolOutcome(t, ctx, approvalID, oldTaskID, issueID, "", "rejected", "user rejected the tool action")
		t.Cleanup(func() {
			_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
			_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id = $1`, runID)
			_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, oldTaskID)
			_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
		})

		testHandler.processDueAIMeRuns(ctx)
		var awaiting, manualReview bool
		var draftSource, replyText, syncedCallID string
		if err := testPool.QueryRow(ctx, `
			SELECT COALESCE((final_payload->>'awaiting_task_result')::boolean, false),
			       COALESCE((final_payload->>'requires_manual_review')::boolean, false),
			       final_payload->>'draft_source', final_payload->>'text',
			       final_payload->>'tool_outcome_call_id'
			FROM ai_me_approval WHERE id = $1
		`, approvalID).Scan(&awaiting, &manualReview, &draftSource, &replyText, &syncedCallID); err != nil {
			t.Fatalf("load unlocked outer approval: %v", err)
		}
		if awaiting || !manualReview || draftSource != "ai_me_tool_rejected" || syncedCallID != callID || !strings.Contains(replyText, "未获批准") {
			t.Fatalf("outer approval awaiting=%v manual=%v source=%q call=%q reply=%q", awaiting, manualReview, draftSource, syncedCallID, replyText)
		}
		approval, err := testHandler.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{ID: parseUUID(approvalID), WorkspaceID: parseUUID(testWorkspaceID)})
		if err != nil {
			t.Fatalf("reload outer approval: %v", err)
		}
		if testHandler.approvalAwaitsEmployeeTask(ctx, approval) {
			t.Fatal("rejected tool outcome should not keep the outer approval locked")
		}
	})
}

func seedToolOutcomeApproval(t *testing.T, ctx context.Context, agentID, suffix string) (string, string, string) {
	t.Helper()
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, description, status, priority,
			assignee_type, assignee_id, creator_type, creator_id
		)
		VALUES ($1, $2, 'Tool approval synchronization fixture.', 'in_review', 'medium', 'agent', $3, 'member', $4)
		RETURNING id
	`, testWorkspaceID, "Tool outcome "+suffix, agentID, testUserID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID) })
	var oldTaskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, result, started_at, completed_at)
		VALUES ($1, $2, $3, 'completed', '{"output":"initial employee result"}'::jsonb, now() - interval '1 minute', now())
		RETURNING id
	`, agentID, issueID, testRuntimeID).Scan(&oldTaskID); err != nil {
		t.Fatalf("create initial task: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, oldTaskID) })
	var approvalID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, source_ref_id,
			issue_id, title, summary, risk_level, confidence, reversibility,
			action_type, action_title, action_description,
			original_payload, final_payload, ai_reasoning_summary,
			created_issue_id, created_task_id
		)
		VALUES (
			$1, $2, 'feishu', $3::text, $4::uuid, '是否回复这条飞书消息', '等待后续工具审批',
			'high', 0.8, 'irreversible', 'send_external_message', '回复飞书消息', '批准后回复原消息',
			'{}'::jsonb,
			jsonb_build_object('text', '等待工具审批。', 'channel', 'feishu', 'message_id', $3::text,
				'awaiting_task_result', true, 'task_id', $5::text, 'issue_id', $4::text),
			'等待内部工具审批', $4::uuid, $5::uuid
		)
		RETURNING id
	`, testWorkspaceID, testUserID, "message-tool-outcome-"+suffix+"-"+randomID(), issueID, oldTaskID).Scan(&approvalID); err != nil {
		t.Fatalf("create outer approval: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID) })
	return issueID, oldTaskID, approvalID
}

func seedTerminalToolOutcome(t *testing.T, ctx context.Context, approvalID, oldTaskID, issueID, newTaskID, status, errorText string) (string, string) {
	t.Helper()
	var runID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, status, input, context_snapshot,
			policy_snapshot, provider, model, final_output, idempotency_key, completed_at
		)
		VALUES (
			$1, $2, 'task_result', $3,
			jsonb_build_object('task_id', $4::text, 'task_status', 'completed', 'approval_id', $5::text,
				'depth', 1, 'original_text', 'tool approval outcome test'),
			'{}'::jsonb, '{}'::jsonb, 'deepseek', 'deepseek-test', '{}'::jsonb, $6, now()
		)
		RETURNING id
	`, testWorkspaceID, testUserID, status, oldTaskID, approvalID, "tool-outcome-run-"+randomID()).Scan(&runID); err != nil {
		t.Fatalf("create terminal run: %v", err)
	}
	var callID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_tool_call (
			run_id, provider_call_id, tool_name, arguments, status,
			risk_level, approval_behavior, result, error, created_issue_id,
			created_task_id, idempotency_key, completed_at
		)
		VALUES (
			$1, $2, 'assign_worker', '{}'::jsonb, $3,
			'medium', 'requires_approval', '{}'::jsonb, $4, $5,
			NULLIF($6, '')::uuid, $7, now()
		)
		RETURNING id
	`, runID, "call-tool-outcome-"+randomID(), status, errorText, issueID, newTaskID, "tool-outcome-call-"+randomID()).Scan(&callID); err != nil {
		t.Fatalf("create terminal tool call: %v", err)
	}
	return runID, callID
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

func (m *failingToolCallingAIMeModel) Configured() bool { return true }
func (m *failingToolCallingAIMeModel) Provider() string { return "deepseek" }
func (m *failingToolCallingAIMeModel) Model() string    { return "deepseek-test" }
func (m *failingToolCallingAIMeModel) Complete(context.Context, string, string) (string, error) {
	m.calls++
	return "", errors.New("simulated task result model failure")
}
func (m *failingToolCallingAIMeModel) CompleteWithTools(context.Context, []AIModelMessage, []AIModelToolDefinition, AIModelOptions) (AIModelCompletion, error) {
	m.calls++
	return AIModelCompletion{}, errors.New("simulated task result model failure")
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
