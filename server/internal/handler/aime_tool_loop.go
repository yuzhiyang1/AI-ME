package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const aiMeMaxToolIterations = 6

type AIMeToolExecutionResult struct {
	Status string
	Result json.RawMessage
	Error  string
}

type AIMeToolExecutor interface {
	Execute(ctx context.Context, call AIModelToolCall) AIMeToolExecutionResult
}

type AIMeToolLoopResult struct {
	Content         string
	Iterations      int
	PendingApproval bool
	Usage           AIModelUsage
	Messages        []AIModelMessage
	Executions      []AIMeToolExecutionResult
}

// runAIMeToolLoop is the provider-neutral orchestration loop. The model may
// select tools, but only the executor can validate policy and touch the system.
func runAIMeToolLoop(ctx context.Context, model AIModelClientWithTools, executor AIMeToolExecutor, messages []AIModelMessage, tools []AIModelToolDefinition, options AIModelOptions) (AIMeToolLoopResult, error) {
	if model == nil {
		return AIMeToolLoopResult{}, errors.New("AI-Me tool model is required")
	}
	if executor == nil {
		return AIMeToolLoopResult{}, errors.New("AI-Me tool executor is required")
	}
	conversation := append([]AIModelMessage(nil), messages...)
	result := AIMeToolLoopResult{Messages: conversation}
	pendingApproval := false

	for iteration := 0; iteration < aiMeMaxToolIterations; iteration++ {
		availableTools := tools
		if pendingApproval {
			availableTools = nil
		}
		completion, err := model.CompleteWithTools(ctx, conversation, availableTools, options)
		if err != nil {
			return AIMeToolLoopResult{}, err
		}
		result.Usage.InputTokens += completion.Usage.InputTokens
		result.Iterations = iteration + 1
		result.Usage.OutputTokens += completion.Usage.OutputTokens
		result.Usage.CacheReadTokens += completion.Usage.CacheReadTokens

		assistant := completion.Message
		if assistant.Role == "" {
			assistant.Role = "assistant"
		}
		if assistant.Content == "" {
			assistant.Content = completion.Content
		}
		for i := range assistant.ToolCalls {
			if strings.TrimSpace(assistant.ToolCalls[i].ID) == "" {
				assistant.ToolCalls[i].ID = "call-" + randomID()
			}
			if strings.TrimSpace(assistant.ToolCalls[i].Type) == "" {
				assistant.ToolCalls[i].Type = "function"
			}
		}
		conversation = append(conversation, assistant)

		if len(assistant.ToolCalls) == 0 {
			content := strings.TrimSpace(firstNonEmpty(completion.Content, assistant.Content))
			if content == "" {
				return AIMeToolLoopResult{}, errors.New("AI-Me tool loop ended without content")
			}
			result.Content = content
			result.Messages = conversation
			return result, nil
		}
		if pendingApproval {
			return AIMeToolLoopResult{}, errors.New("AI-Me requested another tool while approval is pending")
		}

		for _, call := range assistant.ToolCalls {
			execution := executor.Execute(ctx, call)
			if execution.Status == "" {
				execution.Status = "failed"
				execution.Error = firstNonEmpty(execution.Error, "tool executor returned no status")
			}
			result.Executions = append(result.Executions, execution)
			toolResult, err := encodeAIMeToolResult(execution)
			if err != nil {
				return AIMeToolLoopResult{}, fmt.Errorf("encode %s tool result: %w", call.Function.Name, err)
			}
			conversation = append(conversation, AIModelMessage{
				Role:       "tool",
				ToolCallID: call.ID,
				Content:    string(toolResult),
			})
			if execution.Status == "pending_approval" {
				pendingApproval = true
				result.PendingApproval = true
				break
			}
		}
	}

	return AIMeToolLoopResult{}, fmt.Errorf("AI-Me exceeded the %d-iteration tool limit", aiMeMaxToolIterations)
}

func encodeAIMeToolResult(result AIMeToolExecutionResult) ([]byte, error) {
	payload := struct {
		Status string          `json:"status"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  string          `json:"error,omitempty"`
	}{
		Status: result.Status,
		Result: result.Result,
		Error:  result.Error,
	}
	return json.Marshal(payload)
}
