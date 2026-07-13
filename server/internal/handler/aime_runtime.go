package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type aimeRunRecorder struct {
	handler      *Handler
	run          db.AiMeRun
	workspaceID  pgtype.UUID
	leaseOwner   string
	pending      bool
	toolCallByID map[string]db.AiMeToolCall
}

type recordingAIMeToolExecutor struct {
	base     *handlerAIMeToolExecutor
	recorder *aimeRunRecorder
}

func beginAIMeRun(ctx context.Context, executor *handlerAIMeToolExecutor, model string, settings AIMeWorkspaceSettings) (*aimeRunRecorder, *AIModelCompletion, error) {
	if executor == nil || executor.handler == nil {
		return nil, nil, errors.New("AI-Me durable executor is required")
	}
	workspaceID := parseUUID(executor.workspaceID)
	userID := parseUUID(executor.userID)
	if executor.resumeRunID.Valid {
		run, err := executor.handler.Queries.GetAIMeRun(ctx, db.GetAIMeRunParams{ID: executor.resumeRunID, WorkspaceID: workspaceID})
		if err != nil {
			return nil, nil, fmt.Errorf("load resumed AI-Me run: %w", err)
		}
		if run.Status != "running" || !run.LeaseOwner.Valid || run.LeaseOwner.String != executor.leaseOwner {
			return nil, nil, errors.New("AI-Me resumed run lease is not active")
		}
		return &aimeRunRecorder{
			handler: executor.handler, run: run, workspaceID: workspaceID,
			leaseOwner: executor.leaseOwner, toolCallByID: make(map[string]db.AiMeToolCall),
		}, nil, nil
	}
	source := firstNonEmpty(strings.TrimSpace(executor.sourceType), "ai_me_think")
	idempotencyKey := source + ":" + strings.TrimSpace(executor.sourceRefID)
	if strings.TrimSpace(executor.sourceRefID) == "" {
		idempotencyKey = source + ":" + randomID()
	}
	input := jsonBytesOrObject(map[string]any{
		"text":          executor.sourceInput,
		"source_type":   source,
		"source_ref_id": executor.sourceRefID,
	})
	run, err := executor.handler.Queries.CreateAIMeRun(ctx, db.CreateAIMeRunParams{
		WorkspaceID:     workspaceID,
		UserID:          userID,
		Source:          source,
		Input:           input,
		ContextSnapshot: jsonBytesOrObject(executor.context),
		PolicySnapshot:  jsonBytesOrObject(executor.policy),
		Provider:        executor.handler.AIModel.Provider(),
		Model:           model,
		MaxSteps:        aiMeMaxToolIterations,
		IdempotencyKey:  idempotencyKey,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("create AI-Me run: %w", err)
	}
	if run.Status == "running" {
		if recovered, recoverErr := executor.handler.Queries.RecoverAIMeRunFromTerminalToolCalls(ctx, db.RecoverAIMeRunFromTerminalToolCallsParams{ID: run.ID, WorkspaceID: workspaceID}); recoverErr == nil {
			run = recovered
		}
	}
	if run.Status == "succeeded" && len(run.FinalOutput) > 0 {
		content := strings.TrimSpace(string(run.FinalOutput))
		return nil, &AIModelCompletion{Content: content, Message: AIModelMessage{Role: "assistant", Content: content}, Usage: AIModelUsage{
			InputTokens: run.InputTokens, OutputTokens: run.OutputTokens, CacheReadTokens: run.CacheReadTokens,
		}}, nil
	}
	if run.Status != "queued" {
		return nil, nil, fmt.Errorf("AI-Me run is already %s", run.Status)
	}
	leaseOwner := "sync-" + randomID()
	run, err = executor.handler.Queries.StartSpecificAIMeRun(ctx, db.StartSpecificAIMeRunParams{
		LeaseOwner:   leaseOwner,
		LeaseSeconds: 120,
		ID:           run.ID,
		WorkspaceID:  workspaceID,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("start AI-Me run: %w", err)
	}
	return &aimeRunRecorder{
		handler:      executor.handler,
		run:          run,
		workspaceID:  workspaceID,
		leaseOwner:   leaseOwner,
		toolCallByID: make(map[string]db.AiMeToolCall),
	}, nil, nil
}

func (e *recordingAIMeToolExecutor) Execute(ctx context.Context, call AIModelToolCall) AIMeToolExecutionResult {
	if e == nil || e.base == nil || e.recorder == nil {
		return failedAIMeToolExecution("AI-Me durable tool executor is not configured")
	}
	arguments := []byte(strings.TrimSpace(call.Function.Arguments))
	if !json.Valid(arguments) {
		result := failedAIMeToolExecution("tool arguments must be valid JSON")
		return result
	}
	providerCallID := firstNonEmpty(strings.TrimSpace(call.ID), "call-"+randomID())
	idempotencyKey := sha256Hex([]byte(call.Function.Name + "\n" + string(arguments)))
	approvalBehavior := e.base.approvalBehavior(call.Function.Name)
	toolCall, err := e.recorder.handler.Queries.CreateAIMeToolCall(ctx, db.CreateAIMeToolCallParams{
		RunID:            e.recorder.run.ID,
		ProviderCallID:   providerCallID,
		ToolName:         call.Function.Name,
		Arguments:        arguments,
		RiskLevel:        aimeToolRiskLevel(call.Function.Name),
		ApprovalBehavior: approvalBehavior,
		IdempotencyKey:   idempotencyKey,
		WorkspaceID:      e.recorder.workspaceID,
	})
	if err != nil {
		return failedAIMeToolExecution("failed to persist tool call")
	}
	e.recorder.toolCallByID[providerCallID] = toolCall
	if toolCall.Status == "succeeded" {
		return AIMeToolExecutionResult{Status: "succeeded", Result: toolCall.Result}
	}
	if toolCall.Status == "waiting_approval" {
		e.recorder.pending = true
		return AIMeToolExecutionResult{Status: "pending_approval", Result: toolCall.Result}
	}

	if approvalBehavior == "requires_approval" {
		e.base.toolCallID = toolCall.ID
		result := e.base.Execute(ctx, call)
		e.base.toolCallID = pgtype.UUID{}
		if result.Status == "failed" {
			_, _ = e.recorder.handler.Queries.FailAIMeToolCall(ctx, db.FailAIMeToolCallParams{Error: result.Error, ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID})
			return result
		}
		waiting, err := e.recorder.handler.Queries.GetAIMeToolCall(ctx, db.GetAIMeToolCallParams{ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID})
		if err != nil || waiting.Status != "waiting_approval" {
			return failedAIMeToolExecution("tool approval transaction did not enter waiting state")
		}
		e.recorder.pending = true
		return result
	}

	if _, err := e.recorder.handler.Queries.StartAIMeToolCall(ctx, db.StartAIMeToolCallParams{ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID}); err != nil {
		message := "failed to start tool call: " + err.Error()
		_, _ = e.recorder.handler.Queries.FailAIMeToolCall(ctx, db.FailAIMeToolCallParams{Error: message, ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID})
		return failedAIMeToolExecution(message)
	}
	e.base.toolCallID = toolCall.ID
	result := e.base.Execute(ctx, call)
	e.base.toolCallID = pgtype.UUID{}
	if result.Status == "failed" {
		_, _ = e.recorder.handler.Queries.FailAIMeToolCall(ctx, db.FailAIMeToolCallParams{Error: result.Error, ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID})
		return result
	}
	persisted, persistedErr := e.recorder.handler.Queries.GetAIMeToolCall(ctx, db.GetAIMeToolCallParams{ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID})
	if persistedErr == nil && persisted.Status == "succeeded" {
		return result
	}
	if _, err := e.recorder.handler.Queries.CompleteAIMeToolCall(ctx, db.CompleteAIMeToolCallParams{
		Result:           result.Result,
		CreatedIssueID:   toolResultUUID(result.Result, "created_issue_id"),
		CreatedTaskID:    toolResultUUID(result.Result, "created_task_id"),
		CreatedCommentID: toolResultUUID(result.Result, "created_comment_id"),
		ID:               toolCall.ID,
		WorkspaceID:      e.recorder.workspaceID,
	}); err != nil {
		message := "failed to complete tool call: " + err.Error()
		_, _ = e.recorder.handler.Queries.FailAIMeToolCall(ctx, db.FailAIMeToolCallParams{Error: message, ID: toolCall.ID, WorkspaceID: e.recorder.workspaceID})
		return failedAIMeToolExecution(message)
	}
	if approvalID := toolResultUUID(result.Result, "approval_id"); approvalID.Valid {
		_, _ = e.recorder.handler.Queries.LinkAIMeApprovalToolCall(ctx, db.LinkAIMeApprovalToolCallParams{ToolCallID: toolCall.ID, ApprovalID: approvalID, WorkspaceID: e.recorder.workspaceID})
	}
	return result
}

func (e *handlerAIMeToolExecutor) approvalBehavior(toolName string) string {
	switch toolName {
	case "create_issue":
		action := AIMeSuggestedAction{Type: "create_task"}
		if aimeActionRequiresApproval(AIMeThinkResponse{RiskLevel: "medium"}, action, e.policy) {
			return "requires_approval"
		}
	case "assign_worker":
		action := AIMeSuggestedAction{Type: "assign_worker"}
		if aimeActionRequiresApproval(AIMeThinkResponse{RiskLevel: "medium"}, action, e.policy) {
			return "requires_approval"
		}
	}
	return "auto_execute"
}

func aimeToolRiskLevel(toolName string) string {
	switch toolName {
	case "create_issue", "assign_worker":
		return "medium"
	default:
		return "low"
	}
}

func (r *aimeRunRecorder) finish(ctx context.Context, result AIMeToolLoopResult, provider, model string) error {
	usageJSON := jsonBytesOrObject(result.Usage)
	for i, message := range result.Messages {
		var toolCallID pgtype.UUID
		if message.ToolCallID != "" {
			if call, ok := r.toolCallByID[message.ToolCallID]; ok {
				toolCallID = call.ID
			}
		}
		stepUsage := []byte(`{}`)
		if i == len(result.Messages)-1 {
			stepUsage = usageJSON
		}
		if _, err := r.handler.Queries.AppendAIMeRunStep(ctx, db.AppendAIMeRunStepParams{
			RunID:       r.run.ID,
			Sequence:    int32(i + 1),
			StepType:    firstNonEmpty(message.Role, "message"),
			Message:     jsonBytesOrObject(message),
			ToolCallID:  toolCallID,
			Provider:    provider,
			Model:       model,
			Usage:       stepUsage,
			WorkspaceID: r.workspaceID,
		}); err != nil {
			return fmt.Errorf("append AI-Me run step: %w", err)
		}
	}
	cost := estimateAIMeModelCostMicrousd(provider, model, result.Usage)
	if r.pending {
		_, err := r.handler.Queries.UpdateWaitingAIMeRunProgress(ctx, db.UpdateWaitingAIMeRunProgressParams{
			Provider:        provider,
			Model:           model,
			StepCount:       int32(result.Iterations),
			InputTokens:     result.Usage.InputTokens,
			OutputTokens:    result.Usage.OutputTokens,
			CacheReadTokens: result.Usage.CacheReadTokens,
			CostMicrousd:    cost,
			ID:              r.run.ID,
			WorkspaceID:     r.workspaceID,
		})
		return err
	}
	if _, err := r.handler.Queries.UpdateAIMeRunProgress(ctx, db.UpdateAIMeRunProgressParams{
		Provider:        provider,
		Model:           model,
		StepCount:       int32(result.Iterations),
		InputTokens:     result.Usage.InputTokens,
		OutputTokens:    result.Usage.OutputTokens,
		CacheReadTokens: result.Usage.CacheReadTokens,
		CostMicrousd:    cost,
		ID:              r.run.ID,
		WorkspaceID:     r.workspaceID,
		LeaseOwner:      r.leaseOwner,
	}); err != nil {
		return fmt.Errorf("update AI-Me run progress: %w", err)
	}
	finalOutput := []byte(extractJSONObject(result.Content))
	if !json.Valid(finalOutput) {
		finalOutput = jsonBytesOrObject(map[string]any{"content": result.Content})
	}
	_, err := r.handler.Queries.CompleteAIMeRun(ctx, db.CompleteAIMeRunParams{FinalOutput: finalOutput, ID: r.run.ID, WorkspaceID: r.workspaceID, LeaseOwner: r.leaseOwner})
	return err
}

func (r *aimeRunRecorder) fail(ctx context.Context, cause error) {
	if r == nil || cause == nil {
		return
	}
	_, _ = r.handler.Queries.FailAIMeRun(ctx, db.FailAIMeRunParams{LastError: truncateText(cause.Error(), 1000), ID: r.run.ID, WorkspaceID: r.workspaceID, LeaseOwner: r.leaseOwner})
}

func toolResultUUID(raw []byte, key string) pgtype.UUID {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return pgtype.UUID{}
	}
	value, _ := payload[key].(string)
	parsed, err := parseUUIDLoose(value)
	if err != nil {
		return pgtype.UUID{}
	}
	return parsed
}
