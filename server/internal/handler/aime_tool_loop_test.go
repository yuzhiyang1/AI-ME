package handler

import (
	"context"
	"encoding/json"
	"testing"
)

type scriptedAIMeToolModel struct {
	completions []AIModelCompletion
	calls       [][]AIModelMessage
	tools       [][]AIModelToolDefinition
}

func (m *scriptedAIMeToolModel) CompleteWithTools(_ context.Context, messages []AIModelMessage, tools []AIModelToolDefinition, _ AIModelOptions) (AIModelCompletion, error) {
	m.calls = append(m.calls, append([]AIModelMessage(nil), messages...))
	m.tools = append(m.tools, append([]AIModelToolDefinition(nil), tools...))
	completion := m.completions[0]
	m.completions = m.completions[1:]
	return completion, nil
}

type pendingAIMeToolExecutor struct {
	calls []AIModelToolCall
}

func (e *pendingAIMeToolExecutor) Execute(_ context.Context, call AIModelToolCall) AIMeToolExecutionResult {
	e.calls = append(e.calls, call)
	return AIMeToolExecutionResult{Status: "pending_approval", Result: json.RawMessage(`{"approval_id":"approval-1"}`)}
}

func TestAIMeToolLoopStopsDispatchingAfterPendingApproval(t *testing.T) {
	model := &scriptedAIMeToolModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{
			{ID: "call-1", Type: "function", Function: AIModelToolCallFunction{Name: "create_issue", Arguments: `{}`}},
			{ID: "call-2", Type: "function", Function: AIModelToolCallFunction{Name: "assign_worker", Arguments: `{}`}},
		}}},
		{Content: `{"summary":"等待审批","actions":[]}`, Message: AIModelMessage{Role: "assistant", Content: `{"summary":"等待审批","actions":[]}`}},
	}}
	executor := &pendingAIMeToolExecutor{}
	result, err := runAIMeToolLoop(context.Background(), model, executor, []AIModelMessage{{Role: "user", Content: "处理"}}, []AIModelToolDefinition{{Type: "function", Function: AIModelToolFunctionDefinition{Name: "create_issue"}}}, AIModelOptions{})
	if err != nil {
		t.Fatalf("runAIMeToolLoop() error = %v", err)
	}
	if !result.PendingApproval || len(executor.calls) != 1 || executor.calls[0].ID != "call-1" {
		t.Fatalf("pending=%v calls=%#v", result.PendingApproval, executor.calls)
	}
	if len(model.tools) != 2 || len(model.tools[1]) != 0 {
		t.Fatalf("second model call tools = %#v", model.tools)
	}
}

type fakeRecordingAIMeToolExecutor struct {
	calls []AIModelToolCall
}

func (e *fakeRecordingAIMeToolExecutor) Execute(_ context.Context, call AIModelToolCall) AIMeToolExecutionResult {
	e.calls = append(e.calls, call)
	return AIMeToolExecutionResult{
		Status: "succeeded",
		Result: json.RawMessage(`{"issue_id":"issue-1","identifier":"MUL-101"}`),
	}
}

func TestAIMeToolLoopReturnsToolResultToModel(t *testing.T) {
	model := &scriptedAIMeToolModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{{
			ID:   "call-1",
			Type: "function",
			Function: AIModelToolCallFunction{
				Name:      "create_issue",
				Arguments: `{"title":"核查退款进度"}`,
			},
		}}}},
		{Content: "已创建 MUL-101。", Message: AIModelMessage{Role: "assistant", Content: "已创建 MUL-101。"}},
	}}
	executor := &fakeRecordingAIMeToolExecutor{}

	result, err := runAIMeToolLoop(context.Background(), model, executor, []AIModelMessage{
		{Role: "system", Content: "你是 AI-Me"},
		{Role: "user", Content: "帮我确认退款进度"},
	}, []AIModelToolDefinition{{Type: "function", Function: AIModelToolFunctionDefinition{Name: "create_issue"}}}, AIModelOptions{})
	if err != nil {
		t.Fatalf("runAIMeToolLoop() error = %v", err)
	}
	if result.Content != "已创建 MUL-101。" {
		t.Fatalf("content = %q", result.Content)
	}
	if len(executor.calls) != 1 || executor.calls[0].Function.Name != "create_issue" {
		t.Fatalf("executed calls = %#v", executor.calls)
	}
	if len(model.calls) != 2 {
		t.Fatalf("model calls = %d", len(model.calls))
	}
	secondTurn := model.calls[1]
	if len(secondTurn) != 4 {
		t.Fatalf("second turn messages = %#v", secondTurn)
	}
	if secondTurn[2].Role != "assistant" || len(secondTurn[2].ToolCalls) != 1 {
		t.Fatalf("assistant tool message = %#v", secondTurn[2])
	}
	if secondTurn[3].Role != "tool" || secondTurn[3].ToolCallID != "call-1" {
		t.Fatalf("tool result message = %#v", secondTurn[3])
	}
	if secondTurn[3].Content != `{"status":"succeeded","result":{"issue_id":"issue-1","identifier":"MUL-101"}}` {
		t.Fatalf("tool result content = %q", secondTurn[3].Content)
	}
}

func TestAIMeToolLoopStopsAtIterationLimit(t *testing.T) {
	toolCall := AIModelToolCall{ID: "call-loop", Type: "function", Function: AIModelToolCallFunction{Name: "get_issue", Arguments: `{}`}}
	model := &scriptedAIMeToolModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{toolCall}}},
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{toolCall}}},
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{toolCall}}},
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{toolCall}}},
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{toolCall}}},
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{toolCall}}},
	}}

	_, err := runAIMeToolLoop(context.Background(), model, &fakeRecordingAIMeToolExecutor{}, []AIModelMessage{{Role: "user", Content: "loop"}}, nil, AIModelOptions{})
	if err == nil {
		t.Fatal("expected iteration limit error")
	}
}

func TestAIMeToolLoopGeneratesMissingToolCallID(t *testing.T) {
	model := &scriptedAIMeToolModel{completions: []AIModelCompletion{
		{Message: AIModelMessage{Role: "assistant", ToolCalls: []AIModelToolCall{{Function: AIModelToolCallFunction{Name: "get_issue", Arguments: `{}`}}}}},
		{Content: "done", Message: AIModelMessage{Role: "assistant", Content: "done"}},
	}}
	executor := &fakeRecordingAIMeToolExecutor{}
	result, err := runAIMeToolLoop(context.Background(), model, executor, []AIModelMessage{{Role: "user", Content: "read"}}, nil, AIModelOptions{})
	if err != nil {
		t.Fatalf("runAIMeToolLoop() error = %v", err)
	}
	if len(executor.calls) != 1 || executor.calls[0].ID == "" {
		t.Fatalf("executed call = %#v", executor.calls)
	}
	var toolMessage AIModelMessage
	for _, message := range result.Messages {
		if message.Role == "tool" {
			toolMessage = message
			break
		}
	}
	if toolMessage.ToolCallID == "" || toolMessage.ToolCallID != executor.calls[0].ID {
		t.Fatalf("tool message = %#v, executed call = %#v", toolMessage, executor.calls[0])
	}
}
