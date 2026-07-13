package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const aiMeMaxContinuationDepth = 3

type aiMeTaskContinuationInput struct {
	TaskID       string `json:"task_id"`
	TaskStatus   string `json:"task_status"`
	ToolCallID   string `json:"tool_call_id"`
	ParentRunID  string `json:"parent_run_id"`
	ApprovalID   string `json:"approval_id,omitempty"`
	ItemID       string `json:"item_id,omitempty"`
	Depth        int    `json:"depth"`
	RootSource   string `json:"root_source,omitempty"`
	RootSourceID string `json:"root_source_id,omitempty"`
	OriginalText string `json:"original_text,omitempty"`
}

func (h *Handler) registerAIMeTaskContinuationListeners() {
	if h == nil || h.Bus == nil {
		return
	}
	for _, eventType := range []string{
		protocol.EventTaskCompleted,
		protocol.EventTaskFailed,
		protocol.EventTaskCancelled,
	} {
		h.Bus.Subscribe(eventType, h.handleAIMeTaskTerminalEvent)
	}
}

func (h *Handler) handleAIMeTaskTerminalEvent(event events.Event) {
	payload, ok := event.Payload.(map[string]any)
	if !ok {
		return
	}
	taskID, _ := payload["task_id"].(string)
	if strings.TrimSpace(taskID) == "" || strings.TrimSpace(event.WorkspaceID) == "" {
		return
	}
	if err := h.enqueueAIMeTaskContinuation(context.Background(), event.WorkspaceID, taskID); err != nil {
		slog.Warn("AI-Me task continuation enqueue failed", "workspace_id", event.WorkspaceID, "task_id", taskID, "error", err)
	}
}

func (h *Handler) enqueueAIMeTaskContinuation(ctx context.Context, workspaceID, taskID string) error {
	workspaceUUID, err := parseUUIDLoose(workspaceID)
	if err != nil {
		return err
	}
	taskUUID, err := parseUUIDLoose(taskID)
	if err != nil {
		return err
	}
	origin, err := h.Queries.FindAIMeTaskOrigin(ctx, db.FindAIMeTaskOriginParams{
		TaskID:      taskUUID,
		WorkspaceID: workspaceUUID,
	})
	if err != nil {
		if isNotFound(err) {
			return nil
		}
		return err
	}
	task, err := h.Queries.GetAgentTask(ctx, taskUUID)
	if err != nil {
		return err
	}
	parentInput := map[string]any{}
	_ = json.Unmarshal(origin.ParentInput, &parentInput)
	depth := intFromJSON(parentInput["depth"]) + 1
	if depth > aiMeMaxContinuationDepth {
		slog.Warn("AI-Me task continuation requires human finalization", "task_id", taskID, "depth", depth)
	}
	input := aiMeTaskContinuationInput{
		TaskID:       taskID,
		TaskStatus:   task.Status,
		ToolCallID:   uuidToString(origin.ToolCallID),
		ParentRunID:  uuidToString(origin.ParentRunID),
		ApprovalID:   stringFromJSON(parentInput["approval_id"]),
		ItemID:       stringFromJSON(parentInput["item_id"]),
		Depth:        depth,
		RootSource:   firstNonEmpty(stringFromJSON(parentInput["root_source"]), "feishu"),
		RootSourceID: stringFromJSON(parentInput["root_source_id"]),
		OriginalText: firstNonEmpty(stringFromJSON(parentInput["original_text"]), stringFromJSON(parentInput["message_text"])),
	}
	if input.ApprovalID == "" {
		return nil
	}
	continuation, err := h.Queries.CreateAIMeRun(ctx, db.CreateAIMeRunParams{
		WorkspaceID:     origin.WorkspaceID,
		UserID:          origin.UserID,
		Source:          "task_result",
		Input:           jsonBytesOrObject(input),
		ContextSnapshot: origin.ContextSnapshot,
		PolicySnapshot:  origin.PolicySnapshot,
		Provider:        origin.Provider,
		Model:           origin.Model,
		MaxSteps:        aiMeMaxToolIterations,
		IdempotencyKey:  "task_result:" + taskID + ":" + task.Status,
	})
	if err != nil {
		return err
	}
	if continuation.Status != "queued" {
		return nil
	}
	return h.markFeishuApprovalWaitingForTask(ctx, origin, input)
}

func (h *Handler) resumeAIMeTaskResultRun(ctx context.Context, run db.AiMeRun, leaseOwner string) error {
	var input aiMeTaskContinuationInput
	if err := json.Unmarshal(run.Input, &input); err != nil {
		return fmt.Errorf("decode task continuation input: %w", err)
	}
	taskID, err := parseUUIDLoose(input.TaskID)
	if err != nil {
		return errors.New("task continuation has invalid task_id")
	}
	approvalID, err := parseUUIDLoose(input.ApprovalID)
	if err != nil {
		return errors.New("task continuation has invalid approval_id")
	}
	task, err := h.Queries.GetAgentTask(ctx, taskID)
	if err != nil {
		return err
	}
	if task.Status != "completed" && task.Status != "failed" && task.Status != "cancelled" {
		return fmt.Errorf("task continuation requires terminal task, got %s", task.Status)
	}
	approval, err := h.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{ID: approvalID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		return err
	}
	if approval.Status != "pending" && approval.Status != "observing" {
		return errors.New("linked approval is no longer awaiting review")
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: task.IssueID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		return err
	}
	workspace, err := h.Queries.GetWorkspace(ctx, run.WorkspaceID)
	if err != nil {
		return err
	}
	settings := aimeWorkspaceSettingsFromJSON(workspace.Settings)
	policy := buildAIMePolicyContext(settings, time.Now())
	contextSummary, err := h.buildAIMeContext(ctx, uuidToString(run.WorkspaceID), uuidToString(run.UserID))
	if err != nil {
		return err
	}
	resultText := aiMeTaskResultText(task)
	decision := aiMeTaskResultFallbackDecision(task, resultText)
	if input.Depth > aiMeMaxContinuationDepth {
		decision = aiMeTaskResultDepthLimitDecision(task, resultText)
	}
	model := run.Model
	provider := run.Provider
	usage := AIModelUsage{}
	if input.Depth <= aiMeMaxContinuationDepth && settings.Enabled && aimeModelConfiguredForSettings(h.AIModel, settings) && !h.aimeDraftBudgetExceeded(ctx, run.WorkspaceID) {
		systemPrompt := buildAIMeTaskResultSystemPrompt(policy)
		userPrompt, promptErr := h.buildAIMeTaskResultUserPrompt(ctx, input, task, issue, resultText, contextSummary, policy)
		if promptErr != nil {
			return promptErr
		}
		modelCtx, cancel := context.WithTimeout(ctx, feishuDraftTimeout())
		defer cancel()
		executor := &handlerAIMeToolExecutor{
			handler: h, workspaceID: uuidToString(run.WorkspaceID), userID: uuidToString(run.UserID),
			sourceType: "task_result", sourceRefID: input.TaskID, sourceInput: resultText,
			context: contextSummary, policy: policy, resumeRunID: run.ID, leaseOwner: leaseOwner,
		}
		completion, effectiveModel, completeErr := completeAIMeModelWithTools(modelCtx, h.AIModel, systemPrompt, userPrompt, executor, settings)
		if completeErr != nil {
			return completeErr
		}
		model = effectiveModel
		provider = h.AIModel.Provider()
		usage = completion.Usage
		persistedRun, loadErr := h.Queries.GetAIMeRun(ctx, db.GetAIMeRunParams{ID: run.ID, WorkspaceID: run.WorkspaceID})
		if loadErr != nil {
			return loadErr
		}
		// A policy-gated internal tool must be approved before the external
		// reply can move to its final review state.
		if persistedRun.Status == "waiting_approval" {
			return nil
		}
		if parsed, ok := parseAIMeDecision(completion.Content); ok && strings.TrimSpace(parsed.ReplyDraft) != "" {
			decision = parsed
		}
	} else {
		finalOutput := jsonBytesOrObject(decision)
		if _, err := h.Queries.CompleteAIMeRun(ctx, db.CompleteAIMeRunParams{
			FinalOutput: finalOutput, ID: run.ID, WorkspaceID: run.WorkspaceID, LeaseOwner: leaseOwner,
		}); err != nil {
			return err
		}
	}

	toolCalls, err := h.Queries.ListAIMeToolCalls(ctx, db.ListAIMeToolCallsParams{RunID: run.ID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		return err
	}
	for index := len(toolCalls) - 1; index >= 0; index-- {
		if toolCalls[index].CreatedTaskID.Valid {
			nextInput := input
			nextInput.TaskID = uuidToString(toolCalls[index].CreatedTaskID)
			nextInput.ToolCallID = uuidToString(toolCalls[index].ID)
			nextInput.ParentRunID = uuidToString(run.ID)
			nextInput.Depth++
			origin := db.FindAIMeTaskOriginRow{
				ToolCallID: toolCalls[index].ID, ParentRunID: run.ID,
				CreatedIssueID: toolCalls[index].CreatedIssueID, WorkspaceID: run.WorkspaceID,
			}
			return h.markFeishuApprovalWaitingForTask(ctx, origin, nextInput)
		}
	}

	return h.finalizeFeishuApprovalFromTask(ctx, approval, task, issue, decision, provider, model, usage, resultText, input.Depth)
}

func (h *Handler) markFeishuApprovalWaitingForTask(ctx context.Context, origin db.FindAIMeTaskOriginRow, input aiMeTaskContinuationInput) error {
	approvalID, err := parseUUIDLoose(input.ApprovalID)
	if err != nil {
		return err
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	approval, err := qtx.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{ID: approvalID, WorkspaceID: origin.WorkspaceID})
	if err != nil {
		return err
	}
	payload := approvalPayloadMap(approval.FinalPayload)
	if waiting, _ := payload["awaiting_task_result"].(bool); waiting && stringFromJSON(payload["task_id"]) == input.TaskID {
		return nil
	}
	payload["awaiting_task_result"] = true
	payload["task_id"] = input.TaskID
	payload["issue_id"] = uuidToString(origin.CreatedIssueID)
	payload["continuation_depth"] = input.Depth
	updated, err := qtx.UpdatePendingFeishuApprovalForTask(ctx, db.UpdatePendingFeishuApprovalForTaskParams{
		Summary: approval.Summary, RiskLevel: approval.RiskLevel, Confidence: approval.Confidence,
		FinalPayload: jsonBytesOrObject(payload), AiReasoningSummary: approval.AiReasoningSummary,
		CreatedIssueID: origin.CreatedIssueID, CreatedTaskID: parseUUID(input.TaskID),
		ID: approval.ID, WorkspaceID: approval.WorkspaceID,
	})
	if err != nil {
		return err
	}
	if _, err := createAIApprovalEvent(ctx, qtx, updated, "ai_me", updated.RequesterUserID, "edited", updated.Status, updated.Status, map[string]any{
		"kind": "task_result_waiting", "task_id": input.TaskID, "issue_id": uuidToString(origin.CreatedIssueID), "continuation_depth": input.Depth,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	h.publish(protocol.EventApprovalUpdated, uuidToString(updated.WorkspaceID), "ai_me", uuidToString(updated.RequesterUserID), map[string]any{"approval": aiApprovalToResponse(updated)})
	return nil
}

func (h *Handler) markFeishuApprovalWaitingForLatestRunTask(ctx context.Context, approval db.AiMeApproval, run db.AiMeRun) (db.AiMeApproval, error) {
	toolCalls, err := h.Queries.ListAIMeToolCalls(ctx, db.ListAIMeToolCallsParams{RunID: run.ID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		return db.AiMeApproval{}, err
	}
	parentInput := map[string]any{}
	_ = json.Unmarshal(run.Input, &parentInput)
	for index := len(toolCalls) - 1; index >= 0; index-- {
		call := toolCalls[index]
		if !call.CreatedTaskID.Valid {
			continue
		}
		issueID := call.CreatedIssueID
		if !issueID.Valid {
			if task, loadErr := h.Queries.GetAgentTask(ctx, call.CreatedTaskID); loadErr == nil {
				issueID = task.IssueID
			}
		}
		input := aiMeTaskContinuationInput{
			TaskID:       uuidToString(call.CreatedTaskID),
			ToolCallID:   uuidToString(call.ID),
			ParentRunID:  uuidToString(run.ID),
			ApprovalID:   uuidToString(approval.ID),
			ItemID:       stringFromJSON(parentInput["item_id"]),
			Depth:        intFromJSON(parentInput["depth"]) + 1,
			RootSource:   firstNonEmpty(stringFromJSON(parentInput["root_source"]), run.Source),
			RootSourceID: firstNonEmpty(stringFromJSON(parentInput["root_source_id"]), stringFromJSON(parentInput["source_ref_id"])),
			OriginalText: firstNonEmpty(stringFromJSON(parentInput["original_text"]), stringFromJSON(parentInput["message_text"])),
		}
		origin := db.FindAIMeTaskOriginRow{
			ToolCallID: call.ID, ParentRunID: run.ID, CreatedIssueID: issueID,
			WorkspaceID: run.WorkspaceID, UserID: run.UserID,
		}
		if err := h.markFeishuApprovalWaitingForTask(ctx, origin, input); err != nil {
			return db.AiMeApproval{}, err
		}
		return h.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{ID: approval.ID, WorkspaceID: approval.WorkspaceID})
	}
	return approval, nil
}

func (h *Handler) finalizeFeishuApprovalFromTask(ctx context.Context, approval db.AiMeApproval, task db.AgentTaskQueue, issue db.Issue, decision AIMeThinkResponse, provider, model string, usage AIModelUsage, resultText string, depth int) error {
	payload := approvalPayloadMap(approval.FinalPayload)
	payload["text"] = strings.TrimSpace(decision.ReplyDraft)
	payload["draft_source"] = "ai_me_task_result"
	payload["draft_provider"] = provider
	payload["draft_model"] = model
	payload["draft_usage"] = usage
	payload["awaiting_task_result"] = false
	payload["task_id"] = uuidToString(task.ID)
	payload["task_status"] = task.Status
	payload["issue_id"] = uuidToString(issue.ID)
	payload["continuation_depth"] = depth
	confidence, err := numericFromFloat64(normalizeConfidence(decision.Confidence))
	if err != nil {
		return err
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	updated, err := qtx.UpdatePendingFeishuApprovalForTask(ctx, db.UpdatePendingFeishuApprovalForTaskParams{
		Summary:   firstNonEmpty(strings.TrimSpace(decision.Summary), "员工任务已结束，AI-Me 已生成最终回复。"),
		RiskLevel: normalizeRisk(decision.RiskLevel), Confidence: confidence,
		FinalPayload: jsonBytesOrObject(payload), AiReasoningSummary: strings.TrimSpace(decision.ReasoningSummary),
		CreatedIssueID: issue.ID, CreatedTaskID: task.ID, ID: approval.ID, WorkspaceID: approval.WorkspaceID,
	})
	if err != nil {
		return err
	}
	if _, err := createAIApprovalEvent(ctx, qtx, updated, "ai_me", updated.RequesterUserID, "edited", updated.Status, updated.Status, map[string]any{
		"kind": "task_result_ready", "task_id": uuidToString(task.ID), "task_status": task.Status, "issue_id": uuidToString(issue.ID),
	}); err != nil {
		return err
	}
	if err := createAIApprovalEvidence(ctx, qtx, updated.WorkspaceID, updated.ID, CreateAIApprovalEvidenceRequest{
		EvidenceType: "agent_task", Label: "员工执行结果", RefID: uuidToString(task.ID), Quote: truncateText(resultText, 800),
		Metadata: map[string]any{"issue_id": uuidToString(issue.ID), "task_status": task.Status},
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	h.publish(protocol.EventApprovalUpdated, uuidToString(updated.WorkspaceID), "ai_me", uuidToString(updated.RequesterUserID), map[string]any{"approval": aiApprovalToResponse(updated)})
	return nil
}

func approvalPayloadMap(raw []byte) map[string]any {
	payload := map[string]any{}
	_ = json.Unmarshal(raw, &payload)
	return payload
}

func aiMeTaskResultText(task db.AgentTaskQueue) string {
	if len(task.Result) > 0 {
		var result protocol.TaskCompletedPayload
		if json.Unmarshal(task.Result, &result) == nil && strings.TrimSpace(result.Output) != "" {
			return truncateText(result.Output, 12000)
		}
		return truncateText(string(task.Result), 12000)
	}
	if task.Error.Valid {
		return truncateText(task.Error.String, 12000)
	}
	return "员工任务没有返回可读取的结果。"
}

func aiMeTaskResultFallbackDecision(task db.AgentTaskQueue, resultText string) AIMeThinkResponse {
	text := "员工任务已经结束，结果如下：" + truncateText(resultText, 1200)
	if task.Status != "completed" {
		text = "员工任务未能正常完成，需要人工查看工作项中的失败原因。"
	}
	return AIMeThinkResponse{
		Summary: "员工任务已结束，AI-Me 已整理执行结果。", RiskLevel: "medium", Confidence: 0.7,
		NeedApproval: true, ReplyDraft: text, ReasoningSummary: "根据员工任务的终态和持久化结果生成保守回复。",
	}
}

func aiMeTaskResultDepthLimitDecision(task db.AgentTaskQueue, resultText string) AIMeThinkResponse {
	statusText := "最新员工任务已结束"
	if task.Status != "completed" {
		statusText = "最新员工任务未能正常完成"
	}
	return AIMeThinkResponse{
		Summary:          "AI-Me 已达到自动续跑上限，需要人工复核。",
		RiskLevel:        "high",
		Confidence:       1,
		NeedApproval:     true,
		ReplyDraft:       statusText + "。系统已停止继续调用员工，请在工作项中人工复核。最新结果：" + truncateText(resultText, 800),
		ReasoningSummary: "连续员工任务已达到系统配置的最大深度，熔断后转为人工审批。",
	}
}

func buildAIMeTaskResultSystemPrompt(policy AIMePolicyContext) string {
	return fmt.Sprintf(`你是 AI-Me，负责在 AI 员工结束任务后复核结果，并生成待人工审批的最终飞书回复。

必须只输出一个 JSON object，字段与 AI-Me 标准决策一致：summary、risk_level、confidence、need_approval、reply_draft、reasoning_summary、actions、evidence。
- need_approval 必须为 true，actions 必须为空数组。
- 只能陈述 employee_task、issue 和 comments 中有证据的结果，不得编造完成情况。
- 员工成功时，清楚说明实际结果和仍存在的缺口。
- 员工失败或取消时，可以调用工具重试或改派；如果不适合自动重试，生成需要人工介入的回复。
- 如果调用工具创建了新的员工任务，最终 JSON 只说明系统正在继续处理，不得声称已经完成。
- 当前策略：autonomy_level=%s，approval_mode=%s，in_working_hours=%v。`, policy.AutonomyLevel, policy.ApprovalMode, policy.InWorkingHours)
}

func (h *Handler) buildAIMeTaskResultUserPrompt(ctx context.Context, input aiMeTaskContinuationInput, task db.AgentTaskQueue, issue db.Issue, resultText string, summary AIMeContextSummary, policy AIMePolicyContext) (string, error) {
	comments, _ := h.Queries.ListCommentsForIssue(ctx, db.ListCommentsForIssueParams{IssueID: issue.ID, WorkspaceID: issue.WorkspaceID, Limit: 20})
	commentItems := make([]map[string]any, 0, len(comments))
	for _, comment := range comments {
		commentItems = append(commentItems, map[string]any{
			"author_type": comment.AuthorType,
			"content":     truncateText(comment.Content, 1600),
			"created_at":  timestampToString(comment.CreatedAt),
		})
	}
	body := map[string]any{
		"original_message": input.OriginalText,
		"continuation":     input,
		"policy":           policy,
		"employee_task": map[string]any{
			"id": uuidToString(task.ID), "status": task.Status, "result": resultText,
			"error": textToPtr(task.Error), "failure_reason": textToPtr(task.FailureReason),
		},
		"issue": map[string]any{
			"id": uuidToString(issue.ID), "title": issue.Title, "description": issue.Description,
			"status": issue.Status, "comments": commentItems,
		},
		"context": summary,
	}
	raw, err := json.MarshalIndent(body, "", "  ")
	return string(raw), err
}

func stringFromJSON(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func intFromJSON(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	default:
		return 0
	}
}
