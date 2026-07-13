package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type handlerAIMeToolExecutor struct {
	handler     *Handler
	workspaceID string
	userID      string
	sourceType  string
	sourceRefID string
	sourceInput string
	context     AIMeContextSummary
	policy      AIMePolicyContext
	toolCallID  pgtype.UUID
	runID       pgtype.UUID
	resumeRunID pgtype.UUID
	leaseOwner  string
}

func completeAIMeModelWithTools(ctx context.Context, client AIModelClient, systemPrompt, userPrompt string, executor AIMeToolExecutor, settings AIMeWorkspaceSettings) (AIModelCompletion, string, error) {
	toolClient, ok := client.(AIModelClientWithTools)
	if !ok {
		return completeAIMeModelWithUsage(ctx, client, systemPrompt, userPrompt, settings)
	}
	options := aimeModelOptionsFromSettings(settings)
	model := client.Model()
	if configurable, ok := client.(AIModelClientWithOptions); ok {
		model = configurable.EffectiveModel(options)
	}
	baseExecutor, durable := executor.(*handlerAIMeToolExecutor)
	var recorder *aimeRunRecorder
	if durable {
		var replay *AIModelCompletion
		var err error
		recorder, replay, err = beginAIMeRun(ctx, baseExecutor, model, settings)
		if err != nil {
			return AIModelCompletion{}, model, err
		}
		if replay != nil {
			baseExecutor.runID = replay.RunID
			return *replay, model, nil
		}
		baseExecutor.runID = recorder.run.ID
		executor = &recordingAIMeToolExecutor{base: baseExecutor, recorder: recorder}
	}
	result, err := runAIMeToolLoop(ctx, toolClient, executor, []AIModelMessage{
		{Role: "system", Content: systemPrompt + aimeToolCallingPromptSuffix()},
		{Role: "user", Content: userPrompt},
	}, aimeToolDefinitions(), options)
	if err != nil {
		if recorder != nil {
			recorder.fail(ctx, err)
		}
		return AIModelCompletion{}, model, err
	}
	if recorder != nil {
		if err := recorder.finish(ctx, result, client.Provider(), model); err != nil {
			return AIModelCompletion{}, model, err
		}
	}
	completion := AIModelCompletion{
		Content: result.Content,
		Message: AIModelMessage{Role: "assistant", Content: result.Content},
		Usage:   result.Usage,
	}
	if recorder != nil {
		completion.RunID = recorder.run.ID
	}
	return completion, model, nil
}

func aimeToolCallingPromptSuffix() string {
	return `

你可以调用系统提供的 AI-Me tools。需要读取或改变系统状态时，必须调用工具，不得假装已经创建 Issue、分配员工或读取到结果。
- 先用 search_issues 检查重复工作；需要选择员工时先用 list_agents。
- 需要实际处理的消息，使用 create_issue 创建正式工作项；可以同时指定 target_agent_id。
- 只能选择 list_agents 返回的在线员工；不得把任务分配给 runtime_status=offline 的员工。
- 工具返回 pending_approval 时，说明动作正在等待用户批准，不要重复调用。
- 工具返回 succeeded 时，说明内部动作已经完成；不得再描述成“等待审批”。外部回复的 need_approval 只代表回复草稿本身仍需审批。
- 工具完成后再输出原任务要求的最终 JSON；actions 必须为空数组，工具结果写入 summary 或 reasoning_summary。`
}

func (e *handlerAIMeToolExecutor) Execute(ctx context.Context, call AIModelToolCall) AIMeToolExecutionResult {
	if e == nil || e.handler == nil {
		return failedAIMeToolExecution("AI-Me tool executor is not configured")
	}
	switch strings.TrimSpace(call.Function.Name) {
	case "list_agents":
		return e.listAgents(ctx, call.Function.Arguments)
	case "search_issues":
		return e.searchIssues(ctx, call.Function.Arguments)
	case "get_issue":
		return e.getIssue(ctx, call.Function.Arguments)
	case "create_issue":
		return e.createIssue(ctx, call.Function.Arguments)
	case "assign_worker":
		return e.assignWorker(ctx, call.Function.Arguments)
	default:
		return failedAIMeToolExecution("unknown AI-Me tool: " + call.Function.Name)
	}
}

func aimeToolDefinitions() []AIModelToolDefinition {
	return []AIModelToolDefinition{
		newAIMeToolDefinition("list_agents", "列出当前工作区运行时在线、可以接收任务的 AI 员工。", `{"type":"object","properties":{},"additionalProperties":false}`),
		newAIMeToolDefinition("search_issues", "搜索当前工作区最近的 Issue，用于避免重复创建工作。", `{"type":"object","properties":{"query":{"type":"string"},"status":{"type":"string","enum":["backlog","todo","in_progress","in_review","done","blocked","cancelled"]},"limit":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":false}`),
		newAIMeToolDefinition("get_issue", "读取一个 Issue 的详情。", `{"type":"object","properties":{"issue_id":{"type":"string","description":"Issue UUID"}},"required":["issue_id"],"additionalProperties":false}`),
		newAIMeToolDefinition("create_issue", "创建正式 Issue；可选指定 AI 员工，指定后会创建员工任务。", `{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"status":{"type":"string","enum":["backlog","todo"]},"priority":{"type":"string","enum":["urgent","high","medium","low","none"]},"target_agent_id":{"type":"string","description":"必须来自 list_agents 返回的 UUID"},"summary":{"type":"string","description":"给员工的执行说明"}},"required":["title"],"additionalProperties":false}`),
		newAIMeToolDefinition("assign_worker", "把已有 Issue 分配给 AI 员工并创建执行任务。", `{"type":"object","properties":{"issue_id":{"type":"string"},"target_agent_id":{"type":"string"},"priority":{"type":"string","enum":["urgent","high","medium","low","none"]},"summary":{"type":"string"}},"required":["issue_id","target_agent_id"],"additionalProperties":false}`),
	}
}

func newAIMeToolDefinition(name, description, parameters string) AIModelToolDefinition {
	return AIModelToolDefinition{
		Type: "function",
		Function: AIModelToolFunctionDefinition{
			Name:        name,
			Description: description,
			Parameters:  json.RawMessage(parameters),
		},
	}
}

func (e *handlerAIMeToolExecutor) listAgents(ctx context.Context, raw string) AIMeToolExecutionResult {
	var args struct{}
	if err := decodeAIMeToolArguments(raw, &args); err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	agents, err := e.handler.Queries.ListAgents(ctx, parseUUID(e.workspaceID))
	if err != nil {
		return failedAIMeToolExecution("failed to list agents")
	}
	type agentResult struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Status      string `json:"status"`
		RuntimeID   string `json:"runtime_id,omitempty"`
		Model       string `json:"model,omitempty"`
	}
	items := make([]agentResult, 0, len(agents))
	for _, agent := range agents {
		if err := e.handler.ensureApprovalAgentAssignable(ctx, agent, parseUUID(e.workspaceID), parseUUID(e.userID)); err != nil {
			continue
		}
		items = append(items, agentResult{
			ID:          uuidToString(agent.ID),
			Name:        agent.Name,
			Description: agent.Description,
			Status:      agent.Status,
			RuntimeID:   uuidToString(agent.RuntimeID),
			Model:       agent.Model.String,
		})
	}
	return succeededAIMeToolExecution(map[string]any{"agents": items})
}

func (e *handlerAIMeToolExecutor) searchIssues(ctx context.Context, raw string) AIMeToolExecutionResult {
	var args struct {
		Query  string `json:"query"`
		Status string `json:"status"`
		Limit  int32  `json:"limit"`
	}
	if err := decodeAIMeToolArguments(raw, &args); err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	if args.Limit <= 0 || args.Limit > 20 {
		args.Limit = 12
	}
	var status pgtype.Text
	if strings.TrimSpace(args.Status) != "" {
		status = pgtype.Text{String: strings.TrimSpace(args.Status), Valid: true}
	}
	rows, err := e.handler.Queries.ListIssues(ctx, db.ListIssuesParams{
		WorkspaceID: parseUUID(e.workspaceID),
		Limit:       50,
		Status:      status,
	})
	if err != nil {
		return failedAIMeToolExecution("failed to search issues")
	}
	query := strings.ToLower(strings.TrimSpace(args.Query))
	items := make([]map[string]any, 0, args.Limit)
	for _, issue := range rows {
		if query != "" && !strings.Contains(strings.ToLower(issue.Title+" "+issue.Description.String), query) {
			continue
		}
		items = append(items, map[string]any{
			"id":            uuidToString(issue.ID),
			"identifier":    e.handler.getIssuePrefix(ctx, issue.WorkspaceID) + "-" + fmt.Sprint(issue.Number),
			"title":         issue.Title,
			"status":        issue.Status,
			"priority":      issue.Priority,
			"assignee_type": textToPtr(issue.AssigneeType),
			"assignee_id":   uuidToPtr(issue.AssigneeID),
		})
		if len(items) >= int(args.Limit) {
			break
		}
	}
	return succeededAIMeToolExecution(map[string]any{"issues": items})
}

func (e *handlerAIMeToolExecutor) getIssue(ctx context.Context, raw string) AIMeToolExecutionResult {
	var args struct {
		IssueID string `json:"issue_id"`
	}
	if err := decodeAIMeToolArguments(raw, &args); err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	issueID, err := parseUUIDLoose(args.IssueID)
	if err != nil {
		return failedAIMeToolExecution("issue_id must be a valid UUID")
	}
	issue, err := e.handler.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: parseUUID(e.workspaceID)})
	if err != nil {
		return failedAIMeToolExecution("issue not found")
	}
	return succeededAIMeToolExecution(map[string]any{"issue": issueToResponse(issue, e.handler.getIssuePrefix(ctx, issue.WorkspaceID))})
}

func (e *handlerAIMeToolExecutor) createIssue(ctx context.Context, raw string) AIMeToolExecutionResult {
	var args struct {
		Title         string `json:"title"`
		Description   string `json:"description"`
		Status        string `json:"status"`
		Priority      string `json:"priority"`
		TargetAgentID string `json:"target_agent_id"`
		Summary       string `json:"summary"`
	}
	if err := decodeAIMeToolArguments(raw, &args); err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	args.Title = strings.TrimSpace(args.Title)
	if args.Title == "" {
		return failedAIMeToolExecution("title is required")
	}
	payload := map[string]any{
		"title":       args.Title,
		"description": strings.TrimSpace(args.Description),
		"status":      firstNonEmpty(strings.TrimSpace(args.Status), "todo"),
		"priority":    firstNonEmpty(strings.TrimSpace(args.Priority), "none"),
		"summary":     firstNonEmpty(strings.TrimSpace(args.Summary), args.Title),
	}
	if strings.TrimSpace(args.TargetAgentID) != "" {
		payload["target_agent_id"] = strings.TrimSpace(args.TargetAgentID)
	}
	return e.executeWriteTool(ctx, "create_issue", "创建 Issue："+args.Title, "AI-Me 判断需要创建正式工作项。", payload)
}

func (e *handlerAIMeToolExecutor) assignWorker(ctx context.Context, raw string) AIMeToolExecutionResult {
	var args struct {
		IssueID       string `json:"issue_id"`
		TargetAgentID string `json:"target_agent_id"`
		Priority      string `json:"priority"`
		Summary       string `json:"summary"`
	}
	if err := decodeAIMeToolArguments(raw, &args); err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	if strings.TrimSpace(args.IssueID) == "" || strings.TrimSpace(args.TargetAgentID) == "" {
		return failedAIMeToolExecution("issue_id and target_agent_id are required")
	}
	payload := map[string]any{
		"issue_id":        strings.TrimSpace(args.IssueID),
		"target_agent_id": strings.TrimSpace(args.TargetAgentID),
		"priority":        firstNonEmpty(strings.TrimSpace(args.Priority), "medium"),
		"summary":         strings.TrimSpace(args.Summary),
	}
	return e.executeWriteTool(ctx, "assign_worker", "分配 Issue 给 AI 员工", "AI-Me 判断该工作项需要员工执行。", payload)
}

func (e *handlerAIMeToolExecutor) executeWriteTool(ctx context.Context, actionType, title, summary string, payload map[string]any) AIMeToolExecutionResult {
	workspaceID := parseUUID(e.workspaceID)
	userID := parseUUID(e.userID)
	risk := "medium"
	action := AIMeSuggestedAction{Type: actionType, Title: title, Description: summary, Priority: stringValue(payload["priority"])}
	if actionType == "create_issue" {
		action.Type = "create_task"
	}
	response := AIMeThinkResponse{RiskLevel: risk, Confidence: 0.8, Actions: []AIMeSuggestedAction{action}}
	requiresApproval := aimeActionRequiresApproval(response, action, e.policy)
	confidence := response.Confidence
	req := CreateAIApprovalRequest{
		SourceType:         firstNonEmpty(e.sourceType, "ai_me_think"),
		SourceRefID:        e.sourceRefID,
		IssueID:            stringValue(payload["issue_id"]),
		Title:              title,
		Summary:            summary,
		RiskLevel:          risk,
		Confidence:         &confidence,
		Reversibility:      aimeApprovalReversibility(actionType),
		ActionType:         actionType,
		ActionTitle:        title,
		ActionDescription:  summary,
		OriginalPayload:    payload,
		FinalPayload:       payload,
		AIReasoningSummary: summary,
		Evidence: []CreateAIApprovalEvidenceRequest{{
			EvidenceType: mapAIMeEvidenceType(e.sourceType),
			Label:        "触发 AI-Me 的原始输入",
			RefID:        e.sourceRefID,
			Quote:        truncateText(e.sourceInput, 240),
		}},
	}
	params, err := createAIMeApprovalParams(workspaceID, userID, req)
	if err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	params.ToolCallID = e.toolCallID
	params.RunID = e.runID
	if requiresApproval {
		approval, err := e.handler.createAIMeApproval(ctx, e.workspaceID, e.userID, params, req.Evidence)
		if err != nil {
			return failedAIMeToolExecution("failed to create tool approval")
		}
		return pendingAIMeToolExecution(map[string]any{"approval_id": uuidToString(approval.ID)})
	}
	approval, execution, err := e.handler.createAndAutoApproveAIMeApproval(ctx, e.workspaceID, e.userID, params, req.Evidence)
	if err != nil {
		return failedAIMeToolExecution(err.Error())
	}
	if execution.Status != "succeeded" {
		return failedAIMeToolExecution(firstNonEmpty(execution.ExecutionError, "tool execution failed"))
	}
	return succeededAIMeToolExecution(map[string]any{
		"status":            "succeeded",
		"approval_status":   "approved",
		"execution_status":  "succeeded",
		"requires_approval": false,
		"approval_id":       uuidToString(approval.ID),
		"created_issue_id":  uuidToString(execution.CreatedIssueID),
		"created_task_id":   uuidToString(execution.CreatedTaskID),
	})
}

func decodeAIMeToolArguments(raw string, target any) error {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid tool arguments: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("invalid tool arguments: multiple JSON values")
		}
		return fmt.Errorf("invalid tool arguments: %w", err)
	}
	return nil
}

func succeededAIMeToolExecution(value any) AIMeToolExecutionResult {
	raw, err := json.Marshal(value)
	if err != nil {
		return failedAIMeToolExecution("failed to encode tool result")
	}
	return AIMeToolExecutionResult{Status: "succeeded", Result: raw}
}

func failedAIMeToolExecution(message string) AIMeToolExecutionResult {
	return AIMeToolExecutionResult{Status: "failed", Error: strings.TrimSpace(message)}
}

func pendingAIMeToolExecution(value any) AIMeToolExecutionResult {
	raw, err := json.Marshal(value)
	if err != nil {
		return failedAIMeToolExecution("failed to encode pending tool result")
	}
	return AIMeToolExecutionResult{Status: "pending_approval", Result: raw}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}
