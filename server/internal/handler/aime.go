package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const aiMeMaxContextItems = 12
const deepSeekDefaultBaseURL = "https://api.deepseek.com"
const deepSeekDefaultModel = "deepseek-v4-flash"

type AIModelClient interface {
	Configured() bool
	Provider() string
	Model() string
	Complete(ctx context.Context, systemPrompt, userPrompt string) (string, error)
}

type openAICompatibleAIModelClient struct {
	provider    string
	baseURL     string
	apiKey      string
	model       string
	temperature float64
	httpClient  *http.Client
}

func NewAIModelClient(cfg Config) AIModelClient {
	provider := strings.ToLower(strings.TrimSpace(cfg.AIModelProvider))
	if provider == "" {
		provider = "openai"
	}
	baseURL := strings.TrimSpace(cfg.AIModelBaseURL)
	if baseURL == "" {
		switch provider {
		case "deepseek":
			baseURL = deepSeekDefaultBaseURL
		case "openai":
			baseURL = "https://api.openai.com/v1"
		case "openrouter":
			baseURL = "https://openrouter.ai/api/v1"
		}
	}
	model := strings.TrimSpace(cfg.AIModelModel)
	if model == "" && provider == "deepseek" {
		model = deepSeekDefaultModel
	}
	timeout := cfg.AIModelTimeout
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	return &openAICompatibleAIModelClient{
		provider:    provider,
		baseURL:     strings.TrimRight(baseURL, "/"),
		apiKey:      strings.TrimSpace(cfg.AIModelAPIKey),
		model:       model,
		temperature: cfg.AIModelTemperature,
		httpClient:  &http.Client{Timeout: timeout},
	}
}

func (c *openAICompatibleAIModelClient) Configured() bool {
	return c.apiKey != "" && c.model != "" && c.baseURL != ""
}

func (c *openAICompatibleAIModelClient) Provider() string {
	return c.provider
}

func (c *openAICompatibleAIModelClient) Model() string {
	return c.model
}

func (c *openAICompatibleAIModelClient) Complete(ctx context.Context, systemPrompt, userPrompt string) (string, error) {
	if !c.Configured() {
		return "", errors.New("AI-Me LLM is not configured")
	}
	payload := map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"temperature": c.temperature,
	}
	if c.provider == "deepseek" {
		payload["response_format"] = map[string]string{"type": "json_object"}
		payload["thinking"] = map[string]string{"type": "disabled"}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("LLM request failed with status %d: %s", resp.StatusCode, truncateText(string(respBody), 400))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", err
	}
	if len(parsed.Choices) == 0 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		return "", errors.New("LLM returned no content")
	}
	return parsed.Choices[0].Message.Content, nil
}

type AIMeThinkRequest struct {
	Input          string          `json:"input"`
	Intent         string          `json:"intent"`
	SourceType     string          `json:"source_type"`
	SourceRefID    string          `json:"source_ref_id"`
	IssueID        string          `json:"issue_id"`
	Conversation   []AIMeTurnInput `json:"conversation"`
	NeedWorkerPlan bool            `json:"need_worker_plan"`
}

type AIMeTurnInput struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type AIMeThinkResponse struct {
	ID                    string                `json:"id"`
	Mode                  string                `json:"mode"`
	Provider              string                `json:"provider"`
	Model                 string                `json:"model"`
	Configured            bool                  `json:"configured"`
	Summary               string                `json:"summary"`
	RiskLevel             string                `json:"risk_level"`
	Confidence            float64               `json:"confidence"`
	NeedApproval          bool                  `json:"need_approval"`
	ApprovalID            string                `json:"approval_id,omitempty"`
	ApprovalIDs           []string              `json:"approval_ids,omitempty"`
	ReplyDraft            string                `json:"reply_draft"`
	ReasoningSummary      string                `json:"reasoning_summary"`
	Actions               []AIMeSuggestedAction `json:"actions"`
	Evidence              []AIMeEvidence        `json:"evidence"`
	Context               AIMeContextSummary    `json:"context"`
	ConfigurationRequired bool                  `json:"configuration_required"`
	Error                 string                `json:"error,omitempty"`
	CreatedAt             string                `json:"created_at"`
}

type AIMeSuggestedAction struct {
	Type             string `json:"type"`
	Title            string `json:"title"`
	Description      string `json:"description"`
	TargetAgentID    string `json:"target_agent_id,omitempty"`
	TargetAgentName  string `json:"target_agent_name,omitempty"`
	IssueID          string `json:"issue_id,omitempty"`
	Priority         string `json:"priority,omitempty"`
	RequiresApproval bool   `json:"requires_approval"`
}

type AIMeEvidence struct {
	Type  string `json:"type"`
	Label string `json:"label"`
	RefID string `json:"ref_id,omitempty"`
	Quote string `json:"quote,omitempty"`
}

type AIMeContextSummary struct {
	Workspace AIMeWorkspaceContext `json:"workspace"`
	Issues    []AIMeIssueContext   `json:"issues"`
	Agents    []AIMeAgentContext   `json:"agents"`
	Memories  []AIMeMemoryContext  `json:"memories"`
}

type AIMeWorkspaceContext struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Context string `json:"context,omitempty"`
}

type AIMeIssueContext struct {
	ID           string `json:"id"`
	Identifier   string `json:"identifier"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	Priority     string `json:"priority"`
	AssigneeType string `json:"assignee_type,omitempty"`
	AssigneeID   string `json:"assignee_id,omitempty"`
}

type AIMeAgentContext struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Provider      string `json:"provider"`
	Status        string `json:"status"`
	RuntimeStatus string `json:"runtime_status"`
	Model         string `json:"model,omitempty"`
}

type AIMeMemoryContext struct {
	ID                string  `json:"id"`
	Type              string  `json:"type"`
	Category          string  `json:"category,omitempty"`
	Title             string  `json:"title"`
	Content           string  `json:"content"`
	Summary           string  `json:"summary,omitempty"`
	Confidence        float64 `json:"confidence"`
	Sensitivity       string  `json:"sensitivity"`
	ScopeType         string  `json:"scope_type"`
	ExternalUsePolicy string  `json:"external_use_policy"`
}

type AIMeCockpitSummaryResponse struct {
	ActiveTasks            int64 `json:"active_tasks"`
	QueuedTasks            int64 `json:"queued_tasks"`
	RunningTasks           int64 `json:"running_tasks"`
	CompletedTasksToday    int64 `json:"completed_tasks_today"`
	FailedTasksToday       int64 `json:"failed_tasks_today"`
	PendingDecisions       int64 `json:"pending_decisions"`
	HighRiskPending        int64 `json:"high_risk_pending"`
	WaitingExternal        int64 `json:"waiting_external"`
	ExecutionSucceeded     int64 `json:"execution_succeeded"`
	ExecutionFailed        int64 `json:"execution_failed"`
	ExternalReplyPending   int64 `json:"external_reply_pending"`
	AssignWorkerSucceeded  int64 `json:"assign_worker_succeeded"`
	ExternalReplySucceeded int64 `json:"external_reply_succeeded"`
	ActiveMemories         int64 `json:"active_memories"`
	MemoryUsedToday        int64 `json:"memory_used_today"`
	UnreadInbox            int64 `json:"unread_inbox"`
	ActiveIssues           int64 `json:"active_issues"`
}

func (h *Handler) GetAIMeCockpitSummary(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	row, err := h.Queries.GetAIMeCockpitSummary(r.Context(), db.GetAIMeCockpitSummaryParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get AI-Me cockpit summary")
		return
	}
	writeJSON(w, http.StatusOK, AIMeCockpitSummaryResponse{
		ActiveTasks:            row.ActiveTasks,
		QueuedTasks:            row.QueuedTasks,
		RunningTasks:           row.RunningTasks,
		CompletedTasksToday:    row.CompletedTasksToday,
		FailedTasksToday:       row.FailedTasksToday,
		PendingDecisions:       row.PendingDecisions,
		HighRiskPending:        row.HighRiskPending,
		WaitingExternal:        row.WaitingExternal,
		ExecutionSucceeded:     row.ExecutionSucceeded,
		ExecutionFailed:        row.ExecutionFailed,
		ExternalReplyPending:   row.ExternalReplyPending,
		AssignWorkerSucceeded:  row.AssignWorkerSucceeded,
		ExternalReplySucceeded: row.ExternalReplySucceeded,
		ActiveMemories:         row.ActiveMemories,
		MemoryUsedToday:        row.MemoryUsedToday,
		UnreadInbox:            row.UnreadInbox,
		ActiveIssues:           row.ActiveIssues,
	})
}

func (h *Handler) ThinkAIMe(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}

	var req AIMeThinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Input = strings.TrimSpace(req.Input)
	if req.Input == "" {
		writeError(w, http.StatusBadRequest, "input is required")
		return
	}
	ctx, err := h.buildAIMeContext(r.Context(), workspaceID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build AI-Me context")
		return
	}

	if h.AIModel == nil || !h.AIModel.Configured() {
		resp := h.unconfiguredAIMeResponse(ctx)
		writeJSON(w, http.StatusOK, resp)
		return
	}

	systemPrompt := buildAIMeSystemPrompt()
	userPrompt, err := buildAIMeUserPrompt(userID, req, ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build AI-Me prompt")
		return
	}
	raw, err := h.AIModel.Complete(r.Context(), systemPrompt, userPrompt)
	if err != nil {
		resp := h.fallbackAIMeResponse(ctx, "provider_error", "AI-Me 调用 LLM Provider 时失败。", err.Error())
		writeJSON(w, http.StatusOK, resp)
		return
	}
	decision, ok := parseAIMeDecision(raw)
	if !ok {
		resp := h.fallbackAIMeResponse(ctx, "fallback", "AI-Me 已收到模型回复，但回复不是完整 JSON。", raw)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp := AIMeThinkResponse{
		ID:               randomID(),
		Mode:             "llm",
		Provider:         h.AIModel.Provider(),
		Model:            h.AIModel.Model(),
		Configured:       true,
		Summary:          decision.Summary,
		RiskLevel:        normalizeRisk(decision.RiskLevel),
		Confidence:       normalizeConfidence(decision.Confidence),
		NeedApproval:     decision.NeedApproval,
		ReplyDraft:       decision.ReplyDraft,
		ReasoningSummary: decision.ReasoningSummary,
		Actions:          normalizeAIMeActions(decision.Actions),
		Evidence:         normalizeAIMeEvidence(decision.Evidence),
		Context:          ctx,
		CreatedAt:        time.Now().UTC().Format(time.RFC3339),
	}
	enforceAIMeMemoryApprovalPolicy(&resp)
	if resp.Summary == "" {
		resp.Summary = "AI-Me 已完成判断。"
	}
	if resp.ReasoningSummary == "" {
		resp.ReasoningSummary = "模型未提供额外说明。"
	}
	if hasAIMeApprovalRequiredAction(resp.Actions) {
		resp.NeedApproval = true
	}
	h.recordAIMeMemoryUsage(r.Context(), workspaceID, userID, req, resp)
	if approvalReq, shouldCreate := buildAIMeApprovalRequest(req, resp); shouldCreate {
		workspaceUUID := parseUUID(workspaceID)
		userUUID := parseUUID(userID)
		params, err := createAIMeApprovalParams(workspaceUUID, userUUID, approvalReq)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to prepare AI-Me approval")
			return
		}
		approval, err := h.createAIMeApproval(r.Context(), workspaceID, userID, params, approvalReq.Evidence)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create AI-Me approval")
			return
		}
		resp.ApprovalID = uuidToString(approval.ID)
		resp.ApprovalIDs = []string{resp.ApprovalID}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) buildAIMeContext(ctx context.Context, workspaceID, userID string) (AIMeContextSummary, error) {
	workspaceUUID := parseUUID(workspaceID)
	userUUID := parseUUID(userID)
	workspace, err := h.Queries.GetWorkspace(ctx, workspaceUUID)
	if err != nil {
		return AIMeContextSummary{}, err
	}
	issues, err := h.Queries.ListOpenIssues(ctx, db.ListOpenIssuesParams{WorkspaceID: workspaceUUID})
	if err != nil {
		return AIMeContextSummary{}, err
	}
	agents, err := h.Queries.ListAgents(ctx, workspaceUUID)
	if err != nil {
		return AIMeContextSummary{}, err
	}
	runtimes, err := h.Queries.ListAgentRuntimes(ctx, workspaceUUID)
	if err != nil {
		return AIMeContextSummary{}, err
	}
	memories, err := h.Queries.ListMemoryEntries(ctx, db.ListMemoryEntriesParams{
		WorkspaceID: workspaceUUID,
		Status:      optionalTextFromString("active"),
		Limit:       50,
	})
	if err != nil {
		return AIMeContextSummary{}, err
	}
	runtimeByID := make(map[string]db.AgentRuntime, len(runtimes))
	for _, rt := range runtimes {
		runtimeByID[uuidToString(rt.ID)] = rt
	}

	out := AIMeContextSummary{
		Workspace: AIMeWorkspaceContext{
			ID:      uuidToString(workspace.ID),
			Name:    workspace.Name,
			Slug:    workspace.Slug,
			Context: truncateText(pgTextValue(workspace.Context), 900),
		},
		Issues:   []AIMeIssueContext{},
		Agents:   []AIMeAgentContext{},
		Memories: []AIMeMemoryContext{},
	}
	for i, issue := range issues {
		if i >= aiMeMaxContextItems {
			break
		}
		item := AIMeIssueContext{
			ID:         uuidToString(issue.ID),
			Identifier: fmt.Sprintf("%s-%d", workspace.IssuePrefix, issue.Number),
			Title:      truncateText(issue.Title, 160),
			Status:     issue.Status,
			Priority:   issue.Priority,
		}
		if issue.AssigneeType.Valid {
			item.AssigneeType = issue.AssigneeType.String
		}
		if issue.AssigneeID.Valid {
			item.AssigneeID = uuidToString(issue.AssigneeID)
		}
		out.Issues = append(out.Issues, item)
	}
	for i, agent := range agents {
		if i >= aiMeMaxContextItems {
			break
		}
		item := AIMeAgentContext{
			ID:          uuidToString(agent.ID),
			Name:        agent.Name,
			Description: truncateText(agent.Description, 180),
			Status:      agent.Status,
			Model:       pgTextValue(agent.Model),
		}
		if agent.RuntimeID.Valid {
			if rt, ok := runtimeByID[uuidToString(agent.RuntimeID)]; ok {
				item.Provider = rt.Provider
				item.RuntimeStatus = rt.Status
			}
		}
		out.Agents = append(out.Agents, item)
	}
	now := time.Now()
	for _, memory := range memories {
		if len(out.Memories) >= aiMeMaxContextItems {
			break
		}
		if !memoryAllowedForAIMe(memory, userUUID, now) {
			continue
		}
		out.Memories = append(out.Memories, AIMeMemoryContext{
			ID:                uuidToString(memory.ID),
			Type:              memory.Type,
			Category:          memory.Category,
			Title:             truncateText(memory.Title, 120),
			Content:           truncateText(memory.Content, 360),
			Summary:           truncateText(memory.Summary, 220),
			Confidence:        numericToFloat64(memory.Confidence),
			Sensitivity:       memory.Sensitivity,
			ScopeType:         memory.ScopeType,
			ExternalUsePolicy: memory.ExternalUsePolicy,
		})
	}
	return out, nil
}

func memoryAllowedForAIMe(memory db.MemoryEntry, userID pgtype.UUID, now time.Time) bool {
	if memory.Status != "active" || memory.ArchivedAt.Valid {
		return false
	}
	if memory.ExpiresAt.Valid && !memory.ExpiresAt.Time.After(now) {
		return false
	}
	if memory.Sensitivity == "restricted" {
		return false
	}
	if memory.Sensitivity == "private" && (!memory.OwnerUserID.Valid || memory.OwnerUserID.Bytes != userID.Bytes) {
		return false
	}
	switch memory.ScopeType {
	case "workspace":
		return true
	case "user":
		return memory.OwnerUserID.Valid && memory.OwnerUserID.Bytes == userID.Bytes
	default:
		return false
	}
}

func enforceAIMeMemoryApprovalPolicy(resp *AIMeThinkResponse) {
	if resp == nil || strings.TrimSpace(resp.ReplyDraft) == "" {
		return
	}
	if !aimeReplyUsesPolicyGatedMemory(*resp, "with_approval", "never") {
		return
	}
	resp.NeedApproval = true
	for i := range resp.Actions {
		switch normalizeActionType(resp.Actions[i].Type) {
		case "draft_reply", "send_external_message", "post_internal_comment":
			resp.Actions[i].RequiresApproval = true
		}
	}
}

func aimeReplyUsesPolicyGatedMemory(resp AIMeThinkResponse, policies ...string) bool {
	if strings.TrimSpace(resp.ReplyDraft) == "" {
		return false
	}
	policySet := make(map[string]struct{}, len(policies))
	for _, policy := range policies {
		policySet[strings.TrimSpace(policy)] = struct{}{}
	}
	policyByMemoryID := make(map[string]string, len(resp.Context.Memories))
	for _, memory := range resp.Context.Memories {
		policyByMemoryID[strings.TrimSpace(memory.ID)] = strings.TrimSpace(memory.ExternalUsePolicy)
	}
	for _, item := range resp.Evidence {
		if mapAIMeEvidenceType(item.Type) != "memory" {
			continue
		}
		policy := policyByMemoryID[strings.TrimSpace(item.RefID)]
		if _, ok := policySet[policy]; ok {
			return true
		}
	}
	return false
}

func (h *Handler) recordAIMeMemoryUsage(ctx context.Context, workspaceID, userID string, req AIMeThinkRequest, resp AIMeThinkResponse) {
	workspaceUUID, err := parseUUIDLoose(workspaceID)
	if err != nil {
		return
	}
	usedByID, err := parseUUIDLoose(userID)
	if err != nil {
		usedByID = pgtype.UUID{}
	}
	issueID := optionalAIMeUUID(resolveAIMeResponseIssueID(req, resp))
	seen := make(map[string]struct{}, len(resp.Evidence))
	for _, item := range resp.Evidence {
		if mapAIMeEvidenceType(item.Type) != "memory" {
			continue
		}
		memoryID, err := parseUUIDLoose(strings.TrimSpace(item.RefID))
		if err != nil {
			continue
		}
		key := uuidToString(memoryID)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		_, _ = h.Queries.CreateMemoryUsage(ctx, db.CreateMemoryUsageParams{
			WorkspaceID: workspaceUUID,
			MemoryID:    memoryID,
			UsedByType:  "ai_me",
			UsedByID:    usedByID,
			IssueID:     issueID,
			Action:      "ai_me_think",
			Outcome:     truncateText(firstNonEmpty(resp.ID, resp.Summary), 240),
		})
	}
}

func resolveAIMeResponseIssueID(req AIMeThinkRequest, resp AIMeThinkResponse) string {
	for _, action := range resp.Actions {
		if issueID := resolveAIMeIssueID(req, action); issueID != "" {
			return issueID
		}
	}
	if req.SourceType == "issue" {
		return normalizeAIMeIssueID(req.SourceRefID)
	}
	return normalizeAIMeIssueID(req.IssueID)
}

func (h *Handler) unconfiguredAIMeResponse(ctx AIMeContextSummary) AIMeThinkResponse {
	provider, model := "", ""
	if h.AIModel != nil {
		provider = h.AIModel.Provider()
		model = h.AIModel.Model()
	}
	return AIMeThinkResponse{
		ID:                    randomID(),
		Mode:                  "unconfigured",
		Provider:              provider,
		Model:                 model,
		Configured:            false,
		ConfigurationRequired: true,
		Summary:               "AI-Me 的 LLM Provider 还没有配置，所以现在只能展示上下文，不能生成真实判断。",
		RiskLevel:             "medium",
		Confidence:            0,
		NeedApproval:          true,
		ReasoningSummary:      "请先在服务端环境变量中配置 AI_ME_LLM_API_KEY 和 AI_ME_LLM_MODEL。",
		Actions: []AIMeSuggestedAction{{
			Type:             "ask_user",
			Title:            "配置 AI-Me LLM Provider",
			Description:      "设置 AI_ME_LLM_PROVIDER、AI_ME_LLM_API_KEY、AI_ME_LLM_MODEL；OpenRouter 或自定义 OpenAI-compatible 网关可同时设置 AI_ME_LLM_BASE_URL。",
			RequiresApproval: true,
		}},
		Context:   ctx,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func (h *Handler) fallbackAIMeResponse(ctx AIMeContextSummary, mode, summary, detail string) AIMeThinkResponse {
	provider, model := "", ""
	if h.AIModel != nil {
		provider = h.AIModel.Provider()
		model = h.AIModel.Model()
	}
	return AIMeThinkResponse{
		ID:               randomID(),
		Mode:             mode,
		Provider:         provider,
		Model:            model,
		Configured:       true,
		Summary:          summary,
		RiskLevel:        "medium",
		Confidence:       0.25,
		NeedApproval:     true,
		ReplyDraft:       truncateText(detail, 1200),
		ReasoningSummary: "这次结果没有进入可自动执行的结构化状态，请人工检查原始回复后再操作。",
		Actions: []AIMeSuggestedAction{{
			Type:             "ask_user",
			Title:            "人工检查",
			Description:      "模型输出无法被稳定解析，暂不建议交给员工执行。",
			RequiresApproval: true,
		}},
		Context:   ctx,
		Error:     truncateText(detail, 800),
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func buildAIMeSystemPrompt() string {
	return `你是 AI-Me 的指挥中枢，不是 Codex 或 Claude Code 员工。你的工作是判断、拆解和建议调度，不直接执行。

必须只输出一个 JSON object，不要输出 Markdown、解释文字或代码块。JSON shape：
{
  "summary": "一句话判断",
  "risk_level": "low | medium | high",
  "confidence": 0.0,
  "need_approval": true,
  "reply_draft": "可选，对外回复草稿",
  "reasoning_summary": "可读的判断摘要，不要写隐藏思维链",
  "actions": [
    {
      "type": "create_task | assign_worker | draft_reply | send_external_message | post_internal_comment | ask_user | no_action",
      "title": "动作标题",
      "description": "动作说明",
      "target_agent_id": "assign_worker 必填：必须来自 context.agents[].id",
      "target_agent_name": "可选",
      "issue_id": "可选",
      "priority": "low | medium | high | urgent",
      "requires_approval": true
    }
  ],
  "evidence": [
    { "type": "issue | agent | user_input | workspace | memory | document", "label": "证据标题", "ref_id": "可选", "quote": "可选短摘录" }
  ]
}

规则：
- 可以使用 context.memories 中的已确认长期记忆，但只能把相关记忆作为证据，不要编造不存在的记忆。
- 记忆的 external_use_policy=never 时，不得把该记忆内容写进对外回复。
- 记忆的 external_use_policy=with_approval 时，任何使用该记忆生成的对外回复都必须 need_approval=true，并在 evidence 中引用对应 memory id。
- 对外发送、退款、删除、合并、部署、权限、生产数据修改，一律 need_approval=true。
- 只推荐现有 agents 中的员工，不要编造员工。
- 如果 type=assign_worker，必须填 target_agent_id，且只能使用 context.agents 中已经存在的 id。
- 如果信息不足，优先 ask_user，而不是假设事实。
- reasoning_summary 只写可给用户看的摘要，不写逐步思维链。`
}

func buildAIMeUserPrompt(userID string, req AIMeThinkRequest, ctx AIMeContextSummary) (string, error) {
	payload := map[string]any{
		"user_id": userID,
		"request": map[string]any{
			"input":            truncateText(req.Input, 4000),
			"intent":           req.Intent,
			"source_type":      req.SourceType,
			"source_ref_id":    req.SourceRefID,
			"issue_id":         req.IssueID,
			"need_worker_plan": req.NeedWorkerPlan,
			"conversation":     trimAIMeConversation(req.Conversation),
		},
		"context": ctx,
	}
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func trimAIMeConversation(turns []AIMeTurnInput) []AIMeTurnInput {
	if len(turns) > 10 {
		turns = turns[len(turns)-10:]
	}
	out := make([]AIMeTurnInput, 0, len(turns))
	for _, turn := range turns {
		role := strings.TrimSpace(turn.Role)
		if role == "" {
			role = "user"
		}
		out = append(out, AIMeTurnInput{
			Role:    role,
			Content: truncateText(turn.Content, 1200),
		})
	}
	return out
}

func parseAIMeDecision(raw string) (AIMeThinkResponse, bool) {
	candidate := extractJSONObject(raw)
	if candidate == "" {
		return AIMeThinkResponse{}, false
	}
	var decision AIMeThinkResponse
	if err := json.Unmarshal([]byte(candidate), &decision); err != nil {
		return AIMeThinkResponse{}, false
	}
	decision.RiskLevel = normalizeRisk(decision.RiskLevel)
	decision.Confidence = normalizeConfidence(decision.Confidence)
	decision.Actions = normalizeAIMeActions(decision.Actions)
	decision.Evidence = normalizeAIMeEvidence(decision.Evidence)
	return decision, true
}

func extractJSONObject(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}") {
		return s
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}

func normalizeRisk(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "medium", "high":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "medium"
	}
}

func normalizeConfidence(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func normalizeAIMeActions(actions []AIMeSuggestedAction) []AIMeSuggestedAction {
	if len(actions) == 0 {
		return []AIMeSuggestedAction{{
			Type:             "ask_user",
			Title:            "等待确认",
			Description:      "AI-Me 没有给出可执行动作。",
			RequiresApproval: true,
		}}
	}
	out := make([]AIMeSuggestedAction, 0, len(actions))
	for _, action := range actions {
		action.Type = normalizeActionType(action.Type)
		action.Priority = normalizePriority(action.Priority)
		action.Title = strings.TrimSpace(action.Title)
		action.Description = strings.TrimSpace(action.Description)
		if action.Title == "" {
			action.Title = "待确认动作"
		}
		if action.Description == "" {
			action.Description = "需要人工确认后再执行。"
		}
		out = append(out, action)
	}
	return out
}

func normalizeActionType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "create_task", "assign_worker", "draft_reply", "send_external_message", "post_internal_comment", "ask_user", "no_action":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "ask_user"
	}
}

func hasAIMeApprovalRequiredAction(actions []AIMeSuggestedAction) bool {
	for _, action := range actions {
		if action.RequiresApproval {
			return true
		}
	}
	return false
}

// Bridges the LLM decision shape into the approval-center command shape.
func buildAIMeApprovalRequest(req AIMeThinkRequest, resp AIMeThinkResponse) (CreateAIApprovalRequest, bool) {
	action, ok := selectAIMeApprovalAction(req, resp)
	if !ok {
		return CreateAIApprovalRequest{}, false
	}
	issueID := resolveAIMeIssueID(req, action)
	actionType := mapAIMeActionToApprovalType(action.Type, issueID)
	if actionType == "" {
		return CreateAIApprovalRequest{}, false
	}
	if actionType == "send_external_message" {
		if strings.ToLower(strings.TrimSpace(req.SourceType)) != "feishu" {
			return CreateAIApprovalRequest{}, false
		}
		if aimeReplyUsesPolicyGatedMemory(resp, "never") {
			actionType = "draft_reply"
		}
	}
	title := firstNonEmpty(action.Title, resp.Summary, "AI-Me 建议需要审批")
	summary := firstNonEmpty(resp.Summary, action.Description, "AI-Me 已生成一个需要人工确认的动作。")
	actionDescription := firstNonEmpty(action.Description, resp.ReplyDraft, summary)
	commentContent := firstNonEmpty(resp.ReplyDraft, action.Description)
	if actionType == "post_internal_comment" && commentContent != "" {
		actionDescription = commentContent
	}
	confidence := resp.Confidence
	payload := buildAIMeApprovalPayload(req, resp, action, actionType, issueID, commentContent)
	return CreateAIApprovalRequest{
		SourceType:         "ai_me_think",
		SourceRefID:        firstNonEmpty(resp.ID, req.SourceRefID, issueID),
		IssueID:            issueID,
		Title:              title,
		Summary:            summary,
		RiskLevel:          normalizeRisk(resp.RiskLevel),
		Confidence:         &confidence,
		Reversibility:      aimeApprovalReversibility(actionType),
		ActionType:         actionType,
		ActionTitle:        title,
		ActionDescription:  actionDescription,
		OriginalPayload:    payload,
		FinalPayload:       payload,
		AIReasoningSummary: firstNonEmpty(resp.ReasoningSummary, summary),
		Evidence:           buildAIMeApprovalEvidence(req, resp, issueID),
	}, true
}

func selectAIMeApprovalAction(req AIMeThinkRequest, resp AIMeThinkResponse) (AIMeSuggestedAction, bool) {
	for _, action := range resp.Actions {
		issueID := resolveAIMeIssueID(req, action)
		if action.RequiresApproval && mapAIMeActionToApprovalType(action.Type, issueID) != "" {
			return action, true
		}
	}
	if !resp.NeedApproval {
		return AIMeSuggestedAction{}, false
	}
	for _, action := range resp.Actions {
		issueID := resolveAIMeIssueID(req, action)
		if mapAIMeActionToApprovalType(action.Type, issueID) != "" {
			return action, true
		}
	}
	if strings.TrimSpace(resp.ReplyDraft) != "" {
		return AIMeSuggestedAction{
			Type:             "draft_reply",
			Title:            "确认 AI-Me 回复草稿",
			Description:      resp.ReplyDraft,
			RequiresApproval: true,
		}, true
	}
	return AIMeSuggestedAction{}, false
}

func resolveAIMeIssueID(req AIMeThinkRequest, action AIMeSuggestedAction) string {
	if issueID := normalizeAIMeIssueID(action.IssueID); issueID != "" {
		return issueID
	}
	if issueID := normalizeAIMeIssueID(req.IssueID); issueID != "" {
		return issueID
	}
	if strings.TrimSpace(req.SourceType) == "issue" {
		return normalizeAIMeIssueID(req.SourceRefID)
	}
	return ""
}

func normalizeAIMeIssueID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if _, err := parseUUIDLoose(value); err != nil {
		return ""
	}
	return value
}

func mapAIMeActionToApprovalType(actionType, issueID string) string {
	switch normalizeActionType(actionType) {
	case "send_external_message":
		return "send_external_message"
	case "draft_reply", "post_internal_comment":
		if issueID != "" {
			return "post_internal_comment"
		}
		return "draft_reply"
	case "create_task":
		return "create_issue"
	case "assign_worker":
		return "assign_worker"
	case "no_action":
		return "no_action"
	default:
		return ""
	}
}

func buildAIMeApprovalPayload(req AIMeThinkRequest, resp AIMeThinkResponse, action AIMeSuggestedAction, actionType, issueID, commentContent string) map[string]any {
	payload := map[string]any{
		"source":            "ai_me_think",
		"source_type":       req.SourceType,
		"source_ref_id":     req.SourceRefID,
		"ai_me_response_id": resp.ID,
		"ai_me_action_type": action.Type,
		"approval_action":   actionType,
		"summary":           resp.Summary,
	}
	if issueID != "" {
		payload["issue_id"] = issueID
	}
	if commentContent != "" {
		payload["content"] = commentContent
		payload["reply_draft"] = commentContent
	}
	if actionType == "send_external_message" {
		payload["channel"] = strings.ToLower(strings.TrimSpace(req.SourceType))
		payload["message_id"] = strings.TrimSpace(req.SourceRefID)
		payload["text"] = firstNonEmpty(resp.ReplyDraft, action.Description)
	}
	if action.TargetAgentID != "" {
		payload["target_agent_id"] = action.TargetAgentID
	}
	if action.TargetAgentName != "" {
		payload["target_agent_name"] = action.TargetAgentName
	}
	if action.Priority != "" {
		payload["priority"] = action.Priority
	}
	return payload
}

func buildAIMeApprovalEvidence(req AIMeThinkRequest, resp AIMeThinkResponse, issueID string) []CreateAIApprovalEvidenceRequest {
	evidence := make([]CreateAIApprovalEvidenceRequest, 0, len(resp.Evidence)+2)
	if strings.TrimSpace(req.Input) != "" {
		evidence = append(evidence, CreateAIApprovalEvidenceRequest{
			EvidenceType: "user_input",
			Label:        "用户输入",
			Quote:        truncateText(req.Input, 240),
			Metadata: map[string]any{
				"intent": req.Intent,
			},
		})
	}
	if issueID != "" {
		evidence = append(evidence, CreateAIApprovalEvidenceRequest{
			EvidenceType: "issue",
			Label:        "关联 Issue",
			RefID:        issueID,
		})
	}
	for _, item := range resp.Evidence {
		label := firstNonEmpty(item.Label, "AI-Me 证据")
		evidence = append(evidence, CreateAIApprovalEvidenceRequest{
			EvidenceType: mapAIMeEvidenceType(item.Type),
			Label:        label,
			RefID:        strings.TrimSpace(item.RefID),
			Quote:        truncateText(item.Quote, 240),
			Metadata: map[string]any{
				"original_type": item.Type,
			},
		})
	}
	return evidence
}

func mapAIMeEvidenceType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "user_input", "issue", "comment", "activity", "agent_task", "memory", "document", "feishu", "email", "github", "ci", "log":
		return strings.ToLower(strings.TrimSpace(value))
	case "agent":
		return "agent_task"
	default:
		return "document"
	}
}

func aimeApprovalReversibility(actionType string) string {
	switch actionType {
	case "draft_reply", "post_internal_comment", "no_action":
		return "reversible"
	default:
		return "partially_reversible"
	}
}

func createAIMeApprovalParams(workspaceID, userID pgtype.UUID, req CreateAIApprovalRequest) (db.CreateAIApprovalParams, error) {
	confidence := 0.5
	if req.Confidence != nil {
		confidence = *req.Confidence
	}
	confidenceNumeric, err := numericFromFloat64(confidence)
	if err != nil {
		return db.CreateAIApprovalParams{}, err
	}
	sourceType := firstNonEmpty(req.SourceType, "ai_me_think")
	if !approvalSourceTypes[sourceType] {
		sourceType = "ai_me_think"
	}
	actionType := strings.TrimSpace(req.ActionType)
	if !approvalActionTypes[actionType] {
		return db.CreateAIApprovalParams{}, fmt.Errorf("invalid approval action type %q", actionType)
	}
	reversibility := firstNonEmpty(req.Reversibility, "partially_reversible")
	if !approvalReversibilities[reversibility] {
		reversibility = "partially_reversible"
	}
	riskLevel := normalizeRisk(req.RiskLevel)
	originalPayload := jsonBytesOrObject(req.OriginalPayload)
	finalPayload := jsonBytesOrObject(req.FinalPayload)
	if req.FinalPayload == nil {
		finalPayload = originalPayload
	}
	actionTitle := firstNonEmpty(req.ActionTitle, req.Title)
	return db.CreateAIApprovalParams{
		WorkspaceID:        workspaceID,
		RequesterUserID:    userID,
		SourceType:         sourceType,
		SourceRefID:        optionalTextFromString(req.SourceRefID),
		SourceUrl:          optionalTextFromString(req.SourceURL),
		IssueID:            optionalAIMeUUID(req.IssueID),
		InboxItemID:        optionalAIMeUUID(req.InboxItemID),
		TaskQueueID:        optionalAIMeUUID(req.TaskQueueID),
		MemoryID:           optionalAIMeUUID(req.MemoryID),
		Title:              firstNonEmpty(req.Title, actionTitle, "AI-Me 审批"),
		Summary:            strings.TrimSpace(req.Summary),
		RiskLevel:          riskLevel,
		Confidence:         confidenceNumeric,
		Reversibility:      reversibility,
		ActionType:         actionType,
		ActionTitle:        actionTitle,
		ActionDescription:  strings.TrimSpace(req.ActionDescription),
		OriginalPayload:    originalPayload,
		FinalPayload:       finalPayload,
		AiReasoningSummary: strings.TrimSpace(req.AIReasoningSummary),
	}, nil
}

func optionalAIMeUUID(value string) pgtype.UUID {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.UUID{}
	}
	parsed, err := parseUUIDLoose(value)
	if err != nil {
		return pgtype.UUID{}
	}
	return parsed
}

func normalizePriority(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "medium", "high", "urgent":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "medium"
	}
}

func normalizeAIMeEvidence(items []AIMeEvidence) []AIMeEvidence {
	out := make([]AIMeEvidence, 0, len(items))
	for _, item := range items {
		item.Type = strings.TrimSpace(item.Type)
		item.Label = strings.TrimSpace(item.Label)
		item.Quote = truncateText(item.Quote, 240)
		if item.Type == "" {
			item.Type = "workspace"
		}
		if item.Label == "" {
			item.Label = "上下文"
		}
		out = append(out, item)
	}
	return out
}

func pgTextValue(v pgtype.Text) string {
	if !v.Valid {
		return ""
	}
	return v.String
}

func truncateText(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "..."
}
