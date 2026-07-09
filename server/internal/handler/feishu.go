package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type feishuEventCallback struct {
	Challenge string          `json:"challenge"`
	Token     string          `json:"token"`
	Type      string          `json:"type"`
	Header    feishuHeader    `json:"header"`
	Event     feishuEventBody `json:"event"`
}

type feishuHeader struct {
	EventID    string `json:"event_id"`
	EventType  string `json:"event_type"`
	CreateTime string `json:"create_time"`
	Token      string `json:"token"`
	AppID      string `json:"app_id"`
	TenantKey  string `json:"tenant_key"`
}

type feishuEventBody struct {
	Sender  feishuSender  `json:"sender"`
	Message feishuMessage `json:"message"`
}

type feishuSender struct {
	SenderID   feishuSenderID `json:"sender_id"`
	SenderType string         `json:"sender_type"`
	TenantKey  string         `json:"tenant_key"`
}

type feishuSenderID struct {
	OpenID  string `json:"open_id"`
	UnionID string `json:"union_id"`
	UserID  string `json:"user_id"`
}

type feishuMessage struct {
	MessageID   string `json:"message_id"`
	RootID      string `json:"root_id"`
	ParentID    string `json:"parent_id"`
	CreateTime  string `json:"create_time"`
	ChatID      string `json:"chat_id"`
	ChatType    string `json:"chat_type"`
	MessageType string `json:"message_type"`
	Content     string `json:"content"`
}

type feishuTextContent struct {
	Text     string          `json:"text"`
	Mentions []feishuMention `json:"mentions"`
}

type feishuMention struct {
	Key       string         `json:"key"`
	ID        feishuSenderID `json:"id"`
	Name      string         `json:"name"`
	TenantKey string         `json:"tenant_key"`
}

type FeishuIntegrationStatusResponse struct {
	Provider              string   `json:"provider"`
	EventMode             string   `json:"event_mode"`
	IncomingConfigured    bool     `json:"incoming_configured"`
	OutgoingConfigured    bool     `json:"outgoing_configured"`
	WebhookConfigured     bool     `json:"webhook_configured"`
	WebSocketConfigured   bool     `json:"websocket_configured"`
	WorkspaceConfigured   bool     `json:"workspace_configured"`
	WorkspaceMatches      bool     `json:"workspace_matches"`
	OwnerConfigured       bool     `json:"owner_configured"`
	AllowedChatConfigured bool     `json:"allowed_chat_configured"`
	GroupMessagePolicy    string   `json:"group_message_policy"`
	CallbackPath          string   `json:"callback_path"`
	RequiredEvents        []string `json:"required_events"`
	RequiredScopes        []string `json:"required_scopes"`
	Warnings              []string `json:"warnings"`
}

func (h *Handler) GetFeishuIntegrationStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	cfg := feishuConfigFromEnv()
	mode := feishuEventModeFromEnv()
	webhookConfigured := cfg.WebhookToken != ""
	appConfigured := feishuAppCredentialsConfigured()
	workspaceConfigured := cfg.WorkspaceID != "" || cfg.WorkspaceSlug != ""
	workspaceMatches, workspaceWarnings := h.feishuWorkspaceMatches(r.Context(), workspaceUUID, workspaceID, cfg)
	websocketConfigured := appConfigured && workspaceConfigured
	incomingConfigured := workspaceConfigured && workspaceMatches
	if mode == "websocket" {
		incomingConfigured = incomingConfigured && websocketConfigured
	} else {
		incomingConfigured = incomingConfigured && webhookConfigured
	}
	outgoingConfigured := h.Feishu != nil && h.Feishu.Enabled()

	warnings := make([]string, 0, 6)
	warnings = append(warnings, workspaceWarnings...)
	if !workspaceConfigured {
		warnings = append(warnings, "workspace_not_configured")
	}
	if workspaceConfigured && !workspaceMatches {
		warnings = append(warnings, "workspace_mismatch")
	}
	if mode == "webhook" && !webhookConfigured {
		warnings = append(warnings, "webhook_token_missing")
	}
	if mode == "websocket" && !appConfigured {
		warnings = append(warnings, "app_credentials_missing")
	}
	if !outgoingConfigured {
		warnings = append(warnings, "reply_client_not_configured")
	}

	writeJSON(w, http.StatusOK, FeishuIntegrationStatusResponse{
		Provider:              "feishu",
		EventMode:             mode,
		IncomingConfigured:    incomingConfigured,
		OutgoingConfigured:    outgoingConfigured,
		WebhookConfigured:     webhookConfigured,
		WebSocketConfigured:   websocketConfigured,
		WorkspaceConfigured:   workspaceConfigured,
		WorkspaceMatches:      workspaceMatches,
		OwnerConfigured:       cfg.OwnerUserID != "",
		AllowedChatConfigured: cfg.AllowedChatID != "",
		GroupMessagePolicy:    cfg.GroupMessagePolicy,
		CallbackPath:          "/api/integrations/feishu/webhook",
		RequiredEvents:        []string{"im.message.receive_v1"},
		RequiredScopes:        []string{"im:message:receive_as_bot", "im:message:send_as_bot"},
		Warnings:              warnings,
	})
}

func (h *Handler) FeishuWebhook(w http.ResponseWriter, r *http.Request) {
	config := feishuConfigFromEnv()
	if config.WebhookToken == "" {
		slog.Warn("飞书回调未配置", append(logger.RequestAttrs(r), "has_webhook_token", config.WebhookToken != "")...)
		writeError(w, http.StatusNotFound, "feishu webhook is not configured")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var payload feishuEventCallback
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	logAttrs := feishuLogAttrs(r, payload)
	slog.Info("收到飞书回调", logAttrs...)

	if payload.Challenge != "" {
		if !secureEqual(firstNonEmpty(payload.Token, payload.Header.Token), config.WebhookToken) {
			slog.Warn("飞书 Challenge 校验失败", append(logAttrs, "reason", "invalid_token")...)
			writeError(w, http.StatusUnauthorized, "invalid feishu token")
			return
		}
		slog.Info("飞书 Challenge 校验通过", logAttrs...)
		writeJSON(w, http.StatusOK, map[string]string{"challenge": payload.Challenge})
		return
	}

	if !secureEqual(firstNonEmpty(payload.Header.Token, payload.Token), config.WebhookToken) {
		slog.Warn("飞书事件被拒绝", append(logAttrs, "reason", "invalid_token")...)
		writeError(w, http.StatusUnauthorized, "invalid feishu token")
		return
	}

	eventType := firstNonEmpty(payload.Header.EventType, payload.Type)
	if eventType != "im.message.receive_v1" {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "unsupported_event_type", "event_type", eventType)...)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "unsupported_event_type"})
		return
	}

	result, err := h.ingestFeishuMessage(r.Context(), payload, config, logAttrs)
	if err != nil {
		slog.Warn("飞书消息进入 AI-Me 收件箱失败", append(logAttrs, "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to ingest feishu message")
		return
	}
	if result.Status == "ignored" {
		writeJSON(w, http.StatusOK, map[string]string{"status": result.Status, "reason": result.Reason})
		return
	}
	if result.Status == "duplicate" {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        result.Status,
			"inbox_item_id": result.InboxItemID,
			"approval_id":   result.ApprovalID,
		})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":        result.Status,
		"inbox_item_id": result.InboxItemID,
		"approval_id":   result.ApprovalID,
		"workspace_id":  result.WorkspaceID,
		"recipient_id":  result.RecipientID,
	})
}

type feishuIngestResult struct {
	Status      string
	Reason      string
	InboxItemID string
	ApprovalID  string
	WorkspaceID string
	RecipientID string
}

func (h *Handler) ingestFeishuMessage(ctx context.Context, payload feishuEventCallback, config feishuConfig, logAttrs []any) (feishuIngestResult, error) {
	if config.AllowedChatID != "" && payload.Event.Message.ChatID != config.AllowedChatID {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "chat_not_allowed", "allowed_chat_id", config.AllowedChatID)...)
		return feishuIngestResult{Status: "ignored", Reason: "chat_not_allowed"}, nil
	}

	workspace, recipient, err := h.resolveFeishuInboxTarget(ctx, config)
	if err != nil {
		slog.Warn("飞书收件目标解析失败", append(logAttrs, "error", err)...)
		return feishuIngestResult{}, fmt.Errorf("failed to resolve feishu inbox target: %w", err)
	}

	gate := feishuInboundGate(payload, config)
	if !gate.Accept {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", gate.Reason)...)
		return feishuIngestResult{Status: "ignored", Reason: gate.Reason}, nil
	}

	feishuMessageID := feishuSourceMessageID(payload)
	if feishuMessageID == "" {
		slog.Warn("飞书事件被拒绝", append(logAttrs, "reason", "missing_message_id")...)
		return feishuIngestResult{}, fmt.Errorf("message_id is required")
	}

	if existing, err := h.Queries.FindInboxItemByExternalMessage(ctx, db.FindInboxItemByExternalMessageParams{
		WorkspaceID:   workspace.ID,
		RecipientType: "member",
		RecipientID:   recipient.UserID,
		SourceType:    "feishu",
		MessageID:     feishuMessageID,
	}); err == nil {
		slog.Info("飞书消息重复，已跳过", append(logAttrs, "message_id", feishuMessageID, "inbox_item_id", uuidToString(existing.ID))...)
		return feishuIngestResult{
			Status:      "duplicate",
			InboxItemID: uuidToString(existing.ID),
			ApprovalID:  inboxDetailsText(existing.Details, "approval_id"),
		}, nil
	} else if !isNotFound(err) {
		slog.Warn("飞书消息查重失败", append(logAttrs, "message_id", feishuMessageID, "error", err)...)
		return feishuIngestResult{}, fmt.Errorf("failed to check duplicate feishu message: %w", err)
	}

	messageText := feishuMessageText(payload.Event.Message)
	if strings.TrimSpace(messageText) == "" {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "empty_message")...)
		return feishuIngestResult{Status: "ignored", Reason: "empty_message"}, nil
	}

	draft := h.generateFeishuReplyDraft(ctx, workspace, recipient, payload, messageText, gate)
	item, approval, err := h.createFeishuInboxItemAndApproval(ctx, workspace.ID, recipient.UserID, payload, messageText, gate, draft)
	if err != nil {
		slog.Warn("飞书消息创建 AI-Me 收件箱和审批失败", append(logAttrs, "error", err)...)
		return feishuIngestResult{}, fmt.Errorf("failed to create feishu inbox item and approval: %w", err)
	}

	workspaceID := uuidToString(workspace.ID)
	recipientID := uuidToString(recipient.UserID)
	approvalID := uuidToString(approval.ID)
	h.publish(protocol.EventApprovalCreated, workspaceID, "ai_me", recipientID, map[string]any{"approval": aiApprovalToResponse(approval)})
	h.publish(protocol.EventInboxNew, workspaceID, "system", "", map[string]any{"item": inboxToResponse(item)})
	slog.Info("飞书消息已进入 AI-Me 收件箱", append(logAttrs,
		"workspace_id", workspaceID,
		"recipient_id", recipientID,
		"inbox_item_id", uuidToString(item.ID),
		"approval_id", approvalID,
	)...)
	return feishuIngestResult{
		Status:      "received",
		InboxItemID: uuidToString(item.ID),
		ApprovalID:  approvalID,
		WorkspaceID: workspaceID,
		RecipientID: recipientID,
	}, nil
}

type feishuInboundGateResult struct {
	Accept         bool
	Reason         string
	OwnerMentioned bool
	SenderAllowed  bool
}

func feishuInboundGate(payload feishuEventCallback, cfg feishuConfig) feishuInboundGateResult {
	chatType := strings.TrimSpace(payload.Event.Message.ChatType)
	senderAllowed := feishuSenderAllowed(payload.Event.Sender.SenderID, cfg)
	ownerMentioned := feishuOwnerMentioned(payload.Event.Message, cfg)
	if chatType == "p2p" {
		return feishuInboundGateResult{Accept: true, Reason: "p2p", OwnerMentioned: ownerMentioned, SenderAllowed: senderAllowed}
	}
	if cfg.GroupMessagePolicy == "all" || senderAllowed || ownerMentioned {
		return feishuInboundGateResult{Accept: true, Reason: "group_allowed", OwnerMentioned: ownerMentioned, SenderAllowed: senderAllowed}
	}
	return feishuInboundGateResult{Accept: false, Reason: "group_message_without_owner_mention", OwnerMentioned: ownerMentioned, SenderAllowed: senderAllowed}
}

func (h *Handler) resolveFeishuInboxTarget(ctx context.Context, cfg feishuConfig) (db.Workspace, db.Member, error) {
	workspace, err := h.resolveFeishuWorkspace(ctx, cfg)
	if err != nil {
		return db.Workspace{}, db.Member{}, err
	}
	var recipient db.Member
	if cfg.OwnerUserID != "" {
		ownerUUID, err := util.ParseUUID(cfg.OwnerUserID)
		if err != nil {
			return db.Workspace{}, db.Member{}, fmt.Errorf("invalid FEISHU_OWNER_USER_ID: %w", err)
		}
		recipient, err = h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			UserID:      ownerUUID,
			WorkspaceID: workspace.ID,
		})
		if err != nil {
			return db.Workspace{}, db.Member{}, fmt.Errorf("FEISHU_OWNER_USER_ID is not a workspace member: %w", err)
		}
		return workspace, recipient, nil
	}
	recipient, err = h.Queries.GetWorkspaceOwnerMember(ctx, workspace.ID)
	if err != nil {
		return db.Workspace{}, db.Member{}, fmt.Errorf("workspace owner member not found: %w", err)
	}
	return workspace, recipient, nil
}

func (h *Handler) resolveFeishuWorkspace(ctx context.Context, cfg feishuConfig) (db.Workspace, error) {
	if cfg.WorkspaceID != "" {
		workspaceUUID, err := util.ParseUUID(cfg.WorkspaceID)
		if err != nil {
			return db.Workspace{}, fmt.Errorf("invalid FEISHU_WORKSPACE_ID: %w", err)
		}
		return h.Queries.GetWorkspace(ctx, workspaceUUID)
	}
	if cfg.WorkspaceSlug != "" {
		return h.Queries.GetWorkspaceBySlug(ctx, cfg.WorkspaceSlug)
	}
	return db.Workspace{}, fmt.Errorf("FEISHU_WORKSPACE_ID or FEISHU_WORKSPACE_SLUG is required")
}

func (h *Handler) feishuWorkspaceMatches(ctx context.Context, workspaceUUID pgtype.UUID, workspaceID string, cfg feishuConfig) (bool, []string) {
	if cfg.WorkspaceID != "" {
		configuredUUID, err := util.ParseUUID(cfg.WorkspaceID)
		if err != nil {
			return false, []string{"workspace_id_invalid"}
		}
		return uuidToString(configuredUUID) == workspaceID, nil
	}
	if cfg.WorkspaceSlug != "" {
		workspace, err := h.Queries.GetWorkspace(ctx, workspaceUUID)
		if err != nil {
			return false, []string{"workspace_lookup_failed"}
		}
		return workspace.Slug == cfg.WorkspaceSlug, nil
	}
	return false, nil
}

func (h *Handler) createFeishuInboxItemAndApproval(ctx context.Context, workspaceID, recipientID pgtype.UUID, payload feishuEventCallback, messageText string, gate feishuInboundGateResult, draft feishuReplyDraft) (db.InboxItem, db.AiMeApproval, error) {
	// Keep the inbound message, approval, and inbox link atomic for webhook retries.
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)

	item, err := createFeishuInboxItem(ctx, qtx, workspaceID, recipientID, payload, messageText, gate)
	if err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	approvalReq := feishuReplyApprovalRequest(item, payload, messageText, gate, draft)
	params, err := createAIMeApprovalParams(workspaceID, recipientID, approvalReq)
	if err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	approval, err := qtx.CreateAIApproval(ctx, params)
	if err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	for _, evidenceReq := range approvalReq.Evidence {
		if err := createAIApprovalEvidence(ctx, qtx, workspaceID, approval.ID, evidenceReq); err != nil {
			return db.InboxItem{}, db.AiMeApproval{}, err
		}
	}
	eventPayload := map[string]any{
		"source":        "feishu",
		"source_ref_id": feishuSourceMessageID(payload),
		"inbox_item_id": uuidToString(item.ID),
	}
	if _, err := createAIApprovalEvent(ctx, qtx, approval, "ai_me", recipientID, "created", "", approval.Status, eventPayload); err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	item, err = qtx.LinkInboxItemApproval(ctx, db.LinkInboxItemApprovalParams{
		ID:          item.ID,
		WorkspaceID: workspaceID,
		ApprovalID:  uuidToString(approval.ID),
	})
	if err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.InboxItem{}, db.AiMeApproval{}, err
	}
	return item, approval, nil
}

func createFeishuInboxItem(ctx context.Context, q *db.Queries, workspaceID, recipientID pgtype.UUID, payload feishuEventCallback, messageText string, gate feishuInboundGateResult) (db.InboxItem, error) {
	itemType := "new_comment"
	if gate.OwnerMentioned {
		itemType = "mentioned"
	}
	title := feishuInboxTitle(payload, messageText, gate)
	return q.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   workspaceID,
		RecipientType: "member",
		RecipientID:   recipientID,
		Type:          itemType,
		Severity:      "action_required",
		Title:         title,
		Body:          optionalTextFromString(messageText),
		Details:       feishuInboxDetails(payload, messageText, gate),
	})
}

type feishuReplyDraft struct {
	Text             string
	Summary          string
	ReasoningSummary string
	RiskLevel        string
	Confidence       float64
	Source           string
	Provider         string
	Model            string
	Error            string
}

func fallbackFeishuReplyDraft(source, errText string) feishuReplyDraft {
	return feishuReplyDraft{
		Text:             "收到，我会看一下并尽快回复你。",
		Summary:          "飞书收到一条需要处理的消息，AI-Me 已准备保守回复，请确认或编辑后发送。",
		ReasoningSummary: "飞书入站消息属于代表用户对外回复的动作，必须先经过人工审批。",
		RiskLevel:        "high",
		Confidence:       0.55,
		Source:           firstNonEmpty(source, "fallback"),
		Error:            strings.TrimSpace(errText),
	}
}

func (h *Handler) generateFeishuReplyDraft(ctx context.Context, workspace db.Workspace, recipient db.Member, payload feishuEventCallback, messageText string, gate feishuInboundGateResult) feishuReplyDraft {
	draft := fallbackFeishuReplyDraft("fallback", "")
	settings := aimeWorkspaceSettingsFromJSON(workspace.Settings)
	if !settings.Enabled {
		draft.Source = "ai_me_disabled"
		draft.Error = "AI-Me workspace settings are disabled"
		return draft
	}
	if !aimeModelConfiguredForSettings(h.AIModel, settings) {
		draft.Source = "model_unconfigured"
		return draft
	}
	workspaceID := uuidToString(workspace.ID)
	recipientID := uuidToString(recipient.UserID)
	policy := buildAIMePolicyContext(settings, time.Now())
	aimeCtx, err := h.buildAIMeContext(ctx, workspaceID, recipientID)
	if err != nil {
		draft.Source = "context_error"
		draft.Error = err.Error()
		return draft
	}
	systemPrompt := buildFeishuReplyDraftSystemPrompt(policy)
	userPrompt, err := buildFeishuReplyDraftUserPrompt(recipientID, payload, messageText, gate, aimeCtx, policy)
	if err != nil {
		draft.Source = "prompt_error"
		draft.Error = err.Error()
		return draft
	}
	raw, model, err := completeAIMeModel(ctx, h.AIModel, systemPrompt, userPrompt, settings)
	if err != nil {
		draft.Source = "model_error"
		draft.Provider = h.AIModel.Provider()
		draft.Model = model
		draft.Error = err.Error()
		return draft
	}
	decision, ok := parseAIMeDecision(raw)
	if !ok || strings.TrimSpace(decision.ReplyDraft) == "" {
		draft.Source = "model_parse_error"
		draft.Provider = h.AIModel.Provider()
		draft.Model = model
		draft.Error = "model returned an unparseable or empty reply_draft"
		return draft
	}
	enforceAIMeMemoryApprovalPolicy(&decision)
	h.recordAIMeMemoryUsage(ctx, workspaceID, recipientID, AIMeThinkRequest{
		Input:       messageText,
		Intent:      "feishu_reply_draft",
		SourceType:  "feishu",
		SourceRefID: feishuSourceMessageID(payload),
	}, decision)
	return feishuReplyDraft{
		Text:             strings.TrimSpace(decision.ReplyDraft),
		Summary:          firstNonEmpty(decision.Summary, draft.Summary),
		ReasoningSummary: firstNonEmpty(decision.ReasoningSummary, draft.ReasoningSummary),
		RiskLevel:        normalizeRisk(decision.RiskLevel),
		Confidence:       normalizeConfidence(decision.Confidence),
		Source:           "ai_model",
		Provider:         h.AIModel.Provider(),
		Model:            model,
	}
}

func buildFeishuReplyDraftSystemPrompt(policy AIMePolicyContext) string {
	return fmt.Sprintf(`你是 AI-Me，负责为用户收到的飞书消息生成“待审批回复草稿”。

必须只输出一个 JSON object，不要输出 Markdown、解释文字或代码块。JSON shape：
{
  "summary": "一句话判断这条飞书消息",
  "risk_level": "low | medium | high",
  "confidence": 0.0,
  "need_approval": true,
  "reply_draft": "准备发送给对方的中文回复草稿",
  "reasoning_summary": "可给用户看的简短判断摘要，不要写隐藏思维链",
  "actions": [],
  "evidence": [
    { "type": "user_input | memory | document | workspace", "label": "证据标题", "ref_id": "可选", "quote": "可选短摘录" }
  ]
}

规则：
- 这只是草稿，不会直接发送；need_approval 必须为 true。
- 回复必须简洁、礼貌、像真人同事，不要说自己是 AI。
- 不要承诺退款、修复、完成时间或具体结果，除非原消息或上下文明确给出。
- 信息不足时，优先回复“我来确认/我看一下后同步”，不要编造事实。
- 当前工作区策略：autonomy_level=%s，approval_mode=%s，in_working_hours=%v，model_provider=%s，model_name=%s。
- 可以使用 context.memories 中的已确认长期记忆，但 external_use_policy=never 的记忆不得写进对外回复。
- 使用 external_use_policy=with_approval 的记忆时，必须在 evidence 中引用对应 memory id。`,
		policy.AutonomyLevel,
		policy.ApprovalMode,
		policy.InWorkingHours,
		policy.ModelProvider,
		policy.ModelName,
	)
}

func buildFeishuReplyDraftUserPrompt(userID string, payload feishuEventCallback, messageText string, gate feishuInboundGateResult, ctx AIMeContextSummary, policy AIMePolicyContext) (string, error) {
	body := map[string]any{
		"user_id": userID,
		"policy":  policy,
		"feishu_message": map[string]any{
			"message_id":      feishuSourceMessageID(payload),
			"event_id":        payload.Header.EventID,
			"chat_id":         payload.Event.Message.ChatID,
			"chat_type":       payload.Event.Message.ChatType,
			"message_type":    payload.Event.Message.MessageType,
			"text":            truncateText(messageText, 4000),
			"sender_open_id":  payload.Event.Sender.SenderID.OpenID,
			"sender_user_id":  payload.Event.Sender.SenderID.UserID,
			"sender_union_id": payload.Event.Sender.SenderID.UnionID,
			"owner_mentioned": gate.OwnerMentioned,
			"gate_reason":     gate.Reason,
		},
		"context": ctx,
	}
	raw, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func feishuReplyApprovalRequest(item db.InboxItem, payload feishuEventCallback, messageText string, gate feishuInboundGateResult, draft feishuReplyDraft) CreateAIApprovalRequest {
	messageID := feishuSourceMessageID(payload)
	if strings.TrimSpace(draft.Text) == "" {
		draft = fallbackFeishuReplyDraft("fallback", "empty draft")
	}
	confidence := draft.Confidence
	metadata := map[string]any{
		"event_id":        payload.Header.EventID,
		"chat_id":         payload.Event.Message.ChatID,
		"chat_type":       payload.Event.Message.ChatType,
		"message_type":    payload.Event.Message.MessageType,
		"sender_open_id":  payload.Event.Sender.SenderID.OpenID,
		"sender_user_id":  payload.Event.Sender.SenderID.UserID,
		"sender_union_id": payload.Event.Sender.SenderID.UnionID,
		"owner_mentioned": gate.OwnerMentioned,
		"gate_reason":     gate.Reason,
		"draft_source":    draft.Source,
	}
	if draft.Provider != "" {
		metadata["draft_provider"] = draft.Provider
	}
	if draft.Model != "" {
		metadata["draft_model"] = draft.Model
	}
	if draft.Error != "" {
		metadata["draft_error"] = truncateText(draft.Error, 400)
	}
	originalPayload := map[string]any{
		"channel":       "feishu",
		"message_id":    messageID,
		"chat_id":       payload.Event.Message.ChatID,
		"chat_type":     payload.Event.Message.ChatType,
		"incoming_text": messageText,
		"sender":        metadata,
	}
	finalPayload := map[string]any{
		"channel":      "feishu",
		"message_id":   messageID,
		"chat_id":      payload.Event.Message.ChatID,
		"text":         draft.Text,
		"draft_source": draft.Source,
	}
	if draft.Provider != "" {
		finalPayload["draft_provider"] = draft.Provider
	}
	if draft.Model != "" {
		finalPayload["draft_model"] = draft.Model
	}
	return CreateAIApprovalRequest{
		SourceType:         "feishu",
		SourceRefID:        messageID,
		InboxItemID:        uuidToString(item.ID),
		Title:              "是否回复这条飞书消息",
		Summary:            firstNonEmpty(draft.Summary, "飞书收到一条需要处理的消息，AI-Me 已准备回复草稿，请确认或编辑后发送。"),
		RiskLevel:          "high",
		Confidence:         &confidence,
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "回复飞书消息",
		ActionDescription:  "批准后，AI-Me 会通过飞书机器人回复原消息。",
		OriginalPayload:    originalPayload,
		FinalPayload:       finalPayload,
		AIReasoningSummary: firstNonEmpty(draft.ReasoningSummary, "这条飞书消息通过入站规则进入工作区，属于代表用户对外回复的动作，必须先经过人工审批。"),
		Evidence: []CreateAIApprovalEvidenceRequest{
			{
				EvidenceType: "feishu",
				Label:        "飞书原消息",
				RefID:        messageID,
				Quote:        truncateText(messageText, 240),
				Metadata:     metadata,
			},
		},
	}
}

func feishuInboxTitle(payload feishuEventCallback, messageText string, gate feishuInboundGateResult) string {
	prefix := "飞书消息"
	if payload.Event.Message.ChatType != "p2p" {
		prefix = "飞书群消息"
	}
	if gate.OwnerMentioned {
		prefix = "飞书提及"
	}
	summary := truncateText(strings.Join(strings.Fields(messageText), " "), 64)
	if summary == "" {
		return prefix
	}
	return prefix + "：" + summary
}

func feishuInboxDetails(payload feishuEventCallback, messageText string, gate feishuInboundGateResult) []byte {
	details := map[string]any{
		"source_type":     "feishu",
		"source_ref_id":   feishuSourceMessageID(payload),
		"message_id":      feishuSourceMessageID(payload),
		"event_id":        payload.Header.EventID,
		"event_type":      firstNonEmpty(payload.Header.EventType, payload.Type),
		"chat_id":         payload.Event.Message.ChatID,
		"chat_type":       payload.Event.Message.ChatType,
		"message_type":    payload.Event.Message.MessageType,
		"root_id":         payload.Event.Message.RootID,
		"parent_id":       payload.Event.Message.ParentID,
		"create_time":     payload.Event.Message.CreateTime,
		"sender_open_id":  payload.Event.Sender.SenderID.OpenID,
		"sender_user_id":  payload.Event.Sender.SenderID.UserID,
		"sender_union_id": payload.Event.Sender.SenderID.UnionID,
		"sender_type":     payload.Event.Sender.SenderType,
		"tenant_key":      firstNonEmpty(payload.Header.TenantKey, payload.Event.Sender.TenantKey),
		"owner_mentioned": fmt.Sprintf("%t", gate.OwnerMentioned),
		"sender_allowed":  fmt.Sprintf("%t", gate.SenderAllowed),
		"gate_reason":     gate.Reason,
		"text_preview":    truncateText(strings.Join(strings.Fields(messageText), " "), 240),
	}
	return jsonBytesOrObject(details)
}

func inboxDetailsText(details []byte, key string) string {
	var parsed map[string]any
	if err := json.Unmarshal(details, &parsed); err != nil {
		return ""
	}
	value, ok := parsed[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func feishuSourceMessageID(payload feishuEventCallback) string {
	return firstNonEmpty(payload.Event.Message.MessageID, payload.Header.EventID)
}

func feishuLogAttrs(r *http.Request, payload feishuEventCallback) []any {
	return append(logger.RequestAttrs(r), feishuPayloadLogAttrs(payload)...)
}

func feishuPayloadLogAttrs(payload feishuEventCallback) []any {
	return []any{
		"event_id", payload.Header.EventID,
		"event_type", firstNonEmpty(payload.Header.EventType, payload.Type),
		"message_id", payload.Event.Message.MessageID,
		"chat_id", payload.Event.Message.ChatID,
		"chat_type", payload.Event.Message.ChatType,
		"message_type", payload.Event.Message.MessageType,
		"sender_open_id", payload.Event.Sender.SenderID.OpenID,
		"sender_user_id", payload.Event.Sender.SenderID.UserID,
		"sender_union_id", payload.Event.Sender.SenderID.UnionID,
	}
}

type feishuConfig struct {
	WebhookToken       string
	WorkspaceID        string
	WorkspaceSlug      string
	OwnerUserID        string
	AllowedChatID      string
	AllowedOpenID      string
	AllowedUserID      string
	AllowedUnionID     string
	GroupMessagePolicy string
	OwnerName          string
}

func feishuConfigFromEnv() feishuConfig {
	return feishuConfig{
		WebhookToken:       strings.TrimSpace(os.Getenv("FEISHU_WEBHOOK_TOKEN")),
		WorkspaceID:        strings.TrimSpace(os.Getenv("FEISHU_WORKSPACE_ID")),
		WorkspaceSlug:      strings.TrimSpace(os.Getenv("FEISHU_WORKSPACE_SLUG")),
		OwnerUserID:        strings.TrimSpace(os.Getenv("FEISHU_OWNER_USER_ID")),
		AllowedChatID:      strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_CHAT_ID")),
		AllowedOpenID:      strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_OPEN_ID")),
		AllowedUserID:      strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_USER_ID")),
		AllowedUnionID:     strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_UNION_ID")),
		GroupMessagePolicy: firstNonEmpty(os.Getenv("FEISHU_GROUP_MESSAGE_POLICY"), "mention"),
		OwnerName:          firstNonEmpty(os.Getenv("FEISHU_OWNER_NAME"), "玉旨杨"),
	}
}

func feishuSenderAllowed(sender feishuSenderID, cfg feishuConfig) bool {
	if cfg.AllowedOpenID == "" && cfg.AllowedUserID == "" && cfg.AllowedUnionID == "" {
		return false
	}
	return (cfg.AllowedOpenID != "" && sender.OpenID == cfg.AllowedOpenID) ||
		(cfg.AllowedUserID != "" && sender.UserID == cfg.AllowedUserID) ||
		(cfg.AllowedUnionID != "" && sender.UnionID == cfg.AllowedUnionID)
}

func feishuMessageText(message feishuMessage) string {
	if message.MessageType != "text" {
		return strings.TrimSpace(message.Content)
	}
	var content feishuTextContent
	if err := json.Unmarshal([]byte(message.Content), &content); err != nil {
		return strings.TrimSpace(message.Content)
	}
	return strings.TrimSpace(content.Text)
}

func feishuMessageMentions(message feishuMessage) []feishuMention {
	if message.MessageType != "text" {
		return nil
	}
	var content feishuTextContent
	if err := json.Unmarshal([]byte(message.Content), &content); err != nil {
		return nil
	}
	return content.Mentions
}

func feishuOwnerMentioned(message feishuMessage, cfg feishuConfig) bool {
	for _, mention := range feishuMessageMentions(message) {
		if cfg.AllowedOpenID != "" && mention.ID.OpenID == cfg.AllowedOpenID {
			return true
		}
		if cfg.AllowedUserID != "" && mention.ID.UserID == cfg.AllowedUserID {
			return true
		}
		if cfg.AllowedUnionID != "" && mention.ID.UnionID == cfg.AllowedUnionID {
			return true
		}
		if cfg.OwnerName != "" && mention.Name == cfg.OwnerName {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func feishuEventModeFromEnv() string {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("FEISHU_EVENT_MODE")))
	if mode == "websocket" || mode == "ws" {
		return "websocket"
	}
	return "webhook"
}

func feishuAppCredentialsConfigured() bool {
	return strings.TrimSpace(os.Getenv("FEISHU_APP_ID")) != "" &&
		strings.TrimSpace(os.Getenv("FEISHU_APP_SECRET")) != ""
}

func secureEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
