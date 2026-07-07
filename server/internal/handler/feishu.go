package handler

import (
	"bytes"
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

func (h *Handler) FeishuWebhook(w http.ResponseWriter, r *http.Request) {
	config := feishuConfigFromEnv()
	if config.WebhookToken == "" || config.FixedAgentID == "" {
		slog.Warn("飞书回调未配置", append(logger.RequestAttrs(r),
			"has_webhook_token", config.WebhookToken != "",
			"has_fixed_agent_id", config.FixedAgentID != "",
		)...)
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
	if config.AllowedChatID != "" && payload.Event.Message.ChatID != config.AllowedChatID {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "chat_not_allowed", "allowed_chat_id", config.AllowedChatID)...)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "chat_not_allowed"})
		return
	}
	senderAllowed := feishuSenderAllowed(payload.Event.Sender.SenderID, config)
	ownerMentioned := feishuOwnerMentioned(payload.Event.Message, config)
	if !senderAllowed && !ownerMentioned {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "sender_not_allowed_or_owner_not_mentioned")...)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "sender_not_allowed_or_owner_not_mentioned"})
		return
	}

	agentID, err := util.ParseUUID(config.FixedAgentID)
	if err != nil {
		slog.Warn("飞书固定智能体 ID 无效", append(logAttrs, "agent_id", config.FixedAgentID, "error", err)...)
		writeError(w, http.StatusInternalServerError, "invalid fixed feishu agent id")
		return
	}
	agent, err := h.Queries.GetAgent(r.Context(), agentID)
	if err != nil {
		slog.Warn("飞书固定智能体不存在", append(logAttrs, "agent_id", config.FixedAgentID, "error", err)...)
		writeError(w, http.StatusInternalServerError, "fixed feishu agent not found")
		return
	}
	if agent.ArchivedAt.Valid {
		slog.Warn("飞书固定智能体已归档", append(logAttrs, "agent_id", uuidToString(agent.ID))...)
		writeError(w, http.StatusConflict, "fixed feishu agent is archived")
		return
	}

	feishuMessageID := strings.TrimSpace(payload.Event.Message.MessageID)
	if feishuMessageID == "" {
		feishuMessageID = strings.TrimSpace(payload.Header.EventID)
	}
	if feishuMessageID == "" {
		slog.Warn("飞书事件被拒绝", append(logAttrs, "reason", "missing_message_id")...)
		writeError(w, http.StatusBadRequest, "message_id is required")
		return
	}

	if existing, found, err := h.findIssueByFeishuMessageID(r.Context(), agent.WorkspaceID, feishuMessageID); err != nil {
		slog.Warn("飞书消息查重失败", append(logAttrs, "message_id", feishuMessageID, "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to check duplicate feishu message")
		return
	} else if found {
		slog.Info("飞书消息重复，已跳过", append(logAttrs, "message_id", feishuMessageID, "issue_id", uuidToString(existing.ID))...)
		writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "issue_id": uuidToString(existing.ID)})
		return
	}

	messageText := feishuMessageText(payload.Event.Message)
	if strings.TrimSpace(messageText) == "" {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "empty_message")...)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "empty_message"})
		return
	}

	decision, err := h.decideFeishuMessageWithDify(r.Context(), config, agent, payload, messageText, ownerMentioned)
	if err != nil {
		slog.Warn("Dify 飞书意图识别失败", append(logAttrs, "error", err)...)
		writeError(w, http.StatusBadGateway, "failed to classify feishu message")
		return
	}
	slog.Info("Dify 飞书意图识别完成", append(logAttrs,
		"action", decision.Action,
		"task_kind", decision.TaskKind,
		"should_create_issue", decision.ShouldCreateIssue,
		"should_reply", decision.ShouldReply,
		"confidence", decision.Confidence,
		"reason", decision.Reason,
	)...)

	if decision.Action == feishuDifyActionIgnore || !decision.ShouldCreateIssue {
		var approvalID string
		if decision.ShouldReply && decision.ReplyText != "" {
			approval, err := h.createFeishuReplyApproval(r.Context(), agent, payload, messageText, decision.ReplyText, decision, pgtype.UUID{})
			if err != nil {
				slog.Warn("飞书回复审批创建失败", append(logAttrs, "error", err)...)
				writeError(w, http.StatusInternalServerError, "failed to create feishu reply approval")
				return
			}
			approvalID = uuidToString(approval.ID)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":       "handled",
			"action":       decision.Action,
			"task_kind":    decision.TaskKind,
			"should_reply": decision.ShouldReply,
			"approval_id":  approvalID,
		})
		return
	}

	issue, task, err := h.createIssueFromFeishu(r, agent, payload, messageText, body, decision)
	if err != nil {
		slog.Warn("飞书消息创建 issue 失败", append(logAttrs, "agent_id", uuidToString(agent.ID), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create issue from feishu")
		return
	}
	slog.Info("飞书消息已创建 issue 并入队", append(logAttrs,
		"agent_id", uuidToString(agent.ID),
		"workspace_id", uuidToString(agent.WorkspaceID),
		"issue_id", uuidToString(issue.ID),
		"task_id", uuidToString(task.ID),
	)...)

	replyApprovalID := ""
	if decision.ShouldReply {
		replyText := strings.TrimSpace(decision.ReplyText)
		if replyText == "" {
			replyText = fmt.Sprintf("收到，我已创建任务 %s，并交给「%s」处理。\n完成后会在这里同步结果。", h.issueIdentifier(r.Context(), issue), agent.Name)
		}
		approval, err := h.createFeishuReplyApproval(r.Context(), agent, payload, messageText, replyText, decision, issue.ID)
		if err != nil {
			slog.Warn("飞书确认回复审批创建失败", append(logAttrs, "error", err, "issue_id", uuidToString(issue.ID))...)
			writeError(w, http.StatusInternalServerError, "failed to create feishu reply approval")
			return
		}
		replyApprovalID = uuidToString(approval.ID)
		slog.Info("飞书确认回复等待审批", append(logAttrs, "approval_id", uuidToString(approval.ID), "issue_id", uuidToString(issue.ID))...)
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":            "queued",
		"issue_id":          uuidToString(issue.ID),
		"task_id":           uuidToString(task.ID),
		"reply_approval_id": replyApprovalID,
	})
}

func (h *Handler) createFeishuReplyApproval(ctx context.Context, agent db.Agent, payload feishuEventCallback, originalText, replyText string, decision feishuDifyDecision, issueID pgtype.UUID) (db.AiMeApproval, error) {
	replyText = strings.TrimSpace(replyText)
	if replyText == "" {
		return db.AiMeApproval{}, fmt.Errorf("reply text is required")
	}
	messageID := strings.TrimSpace(payload.Event.Message.MessageID)
	if messageID == "" {
		return db.AiMeApproval{}, fmt.Errorf("message_id is required")
	}
	confidence, err := numericFromFloat64(decision.Confidence)
	if err != nil {
		return db.AiMeApproval{}, err
	}
	actionPayload := map[string]any{
		"channel":       "feishu",
		"message_id":    messageID,
		"text":          replyText,
		"chat_id":       payload.Event.Message.ChatID,
		"task_kind":     decision.TaskKind,
		"original_text": originalText,
	}
	userID := ""
	if agent.OwnerID.Valid {
		userID = uuidToString(agent.OwnerID)
	}
	return h.createAIMeApproval(ctx, uuidToString(agent.WorkspaceID), userID, db.CreateAIApprovalParams{
		WorkspaceID:        agent.WorkspaceID,
		RequesterUserID:    agent.OwnerID,
		SourceType:         "feishu",
		SourceRefID:        optionalTextFromString(messageID),
		IssueID:            issueID,
		Title:              "是否发送飞书回复",
		Summary:            "AI-Me 已生成一条飞书回复草稿，发送前需要你确认。",
		RiskLevel:          feishuReplyRiskLevel(decision),
		Confidence:         confidence,
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "发送飞书回复",
		ActionDescription:  replyText,
		OriginalPayload:    jsonBytesOrObject(actionPayload),
		FinalPayload:       jsonBytesOrObject(actionPayload),
		AiReasoningSummary: decision.Reason,
	}, []CreateAIApprovalEvidenceRequest{
		{
			EvidenceType: "feishu",
			Label:        "原始飞书消息",
			RefID:        messageID,
			Quote:        originalText,
			Metadata: map[string]any{
				"chat_id":     payload.Event.Message.ChatID,
				"sender_type": payload.Event.Sender.SenderType,
				"open_id":     payload.Event.Sender.SenderID.OpenID,
				"task_kind":   decision.TaskKind,
			},
		},
	})
}

func feishuReplyRiskLevel(decision feishuDifyDecision) string {
	if decision.Confidence < 0.7 {
		return "high"
	}
	return "medium"
}

func (h *Handler) replyToFeishuMessage(ctx context.Context, payload feishuEventCallback, text string, logAttrs []any, issueID pgtype.UUID) {
	if h.Feishu == nil || !h.Feishu.Enabled() || payload.Event.Message.MessageID == "" {
		slog.Info("飞书确认回复已跳过", append(logAttrs,
			"feishu_client_enabled", h.Feishu != nil && h.Feishu.Enabled(),
			"has_message_id", payload.Event.Message.MessageID != "",
		)...)
		return
	}
	ack, err := h.Feishu.ReplyText(ctx, payload.Event.Message.MessageID, text)
	if err != nil {
		slog.Warn("飞书确认回复发送失败", append(logAttrs, "error", err, "message_id", payload.Event.Message.MessageID, "issue_id", uuidToString(issueID))...)
		return
	}
	if ack.MessageID == "" {
		return
	}
	slog.Info("飞书确认回复已发送", append(logAttrs, "message_id", payload.Event.Message.MessageID, "ack_message_id", ack.MessageID, "issue_id", uuidToString(issueID))...)
	if issueID.Valid {
		h.appendFeishuAckContext(ctx, issueID, ack.MessageID)
	}
}

func feishuLogAttrs(r *http.Request, payload feishuEventCallback) []any {
	return append(logger.RequestAttrs(r),
		"event_id", payload.Header.EventID,
		"event_type", firstNonEmpty(payload.Header.EventType, payload.Type),
		"message_id", payload.Event.Message.MessageID,
		"chat_id", payload.Event.Message.ChatID,
		"chat_type", payload.Event.Message.ChatType,
		"message_type", payload.Event.Message.MessageType,
		"sender_open_id", payload.Event.Sender.SenderID.OpenID,
		"sender_user_id", payload.Event.Sender.SenderID.UserID,
		"sender_union_id", payload.Event.Sender.SenderID.UnionID,
	)
}

func (h *Handler) issueIdentifier(ctx context.Context, issue db.Issue) string {
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	if prefix == "" {
		return uuidToString(issue.ID)
	}
	return fmt.Sprintf("%s-%d", prefix, issue.Number)
}

func (h *Handler) appendFeishuAckContext(ctx context.Context, issueID pgtype.UUID, ackMessageID string) {
	ackRef, err := json.Marshal([]map[string]any{{
		"type":       "feishu_ack_message",
		"message_id": ackMessageID,
	}})
	if err != nil {
		return
	}
	if _, err := h.DB.Exec(ctx, `
UPDATE issue
SET context_refs = COALESCE(context_refs, '[]'::jsonb) || $2::jsonb
WHERE id = $1`, issueID, ackRef); err != nil {
		slog.Warn("append feishu ack context failed", "error", err, "issue_id", uuidToString(issueID), "ack_message_id", ackMessageID)
	}
}

type feishuConfig struct {
	WebhookToken   string
	FixedAgentID   string
	AllowedChatID  string
	AllowedOpenID  string
	AllowedUserID  string
	AllowedUnionID string
	OwnerName      string
	DifyAPIKey     string
	DifyBaseURL    string
	DifyUser       string
}

func feishuConfigFromEnv() feishuConfig {
	return feishuConfig{
		WebhookToken:   strings.TrimSpace(os.Getenv("FEISHU_WEBHOOK_TOKEN")),
		FixedAgentID:   strings.TrimSpace(os.Getenv("FEISHU_FIXED_AGENT_ID")),
		AllowedChatID:  strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_CHAT_ID")),
		AllowedOpenID:  strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_OPEN_ID")),
		AllowedUserID:  strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_USER_ID")),
		AllowedUnionID: strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_UNION_ID")),
		OwnerName:      firstNonEmpty(os.Getenv("FEISHU_OWNER_NAME"), "玉旨杨"),
		DifyAPIKey:     strings.TrimSpace(os.Getenv("FEISHU_DIFY_API_KEY")),
		DifyBaseURL:    firstNonEmpty(os.Getenv("FEISHU_DIFY_BASE_URL"), "http://103.97.176.3/v1"),
		DifyUser:       firstNonEmpty(os.Getenv("FEISHU_DIFY_USER"), "feishu"),
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

func (h *Handler) findIssueByFeishuMessageID(ctx context.Context, workspaceID pgtype.UUID, messageID string) (db.Issue, bool, error) {
	rows, err := h.DB.Query(ctx, `
SELECT id, workspace_id, title, description, status, priority, assignee_type, assignee_id, creator_type, creator_id,
       parent_issue_id, acceptance_criteria, context_refs, position, due_date, created_at, updated_at, number,
       project_id, origin_type, origin_id, first_executed_at, code_context
FROM issue
WHERE workspace_id = $1
  AND context_refs @> $2::jsonb
ORDER BY created_at DESC
LIMIT 1`, workspaceID, []byte(fmt.Sprintf(`[{"type":"feishu_message","message_id":%q}]`, messageID)))
	if err != nil {
		return db.Issue{}, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return db.Issue{}, false, rows.Err()
	}
	var issue db.Issue
	if err := rows.Scan(
		&issue.ID,
		&issue.WorkspaceID,
		&issue.Title,
		&issue.Description,
		&issue.Status,
		&issue.Priority,
		&issue.AssigneeType,
		&issue.AssigneeID,
		&issue.CreatorType,
		&issue.CreatorID,
		&issue.ParentIssueID,
		&issue.AcceptanceCriteria,
		&issue.ContextRefs,
		&issue.Position,
		&issue.DueDate,
		&issue.CreatedAt,
		&issue.UpdatedAt,
		&issue.Number,
		&issue.ProjectID,
		&issue.OriginType,
		&issue.OriginID,
		&issue.FirstExecutedAt,
		&issue.CodeContext,
	); err != nil {
		return db.Issue{}, false, err
	}
	return issue, true, rows.Err()
}

func (h *Handler) createIssueFromFeishu(r *http.Request, agent db.Agent, payload feishuEventCallback, text string, raw []byte, decision feishuDifyDecision) (db.Issue, db.AgentTaskQueue, error) {
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}
	defer tx.Rollback(r.Context())

	qtx := h.Queries.WithTx(tx)
	issueNumber, err := qtx.IncrementIssueCounter(r.Context(), agent.WorkspaceID)
	if err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}

	codeContext := decodeCodeContext(agent.DefaultCodeContext)
	codeContextJSON, err := json.Marshal(codeContext)
	if err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}
	contextRefsJSON, err := json.Marshal([]map[string]any{feishuContextRef(payload, raw)})
	if err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}

	description := buildFeishuIssueDescription(payload, text, codeContext, decision)
	title := strings.TrimSpace(decision.IssueTitle)
	if title == "" {
		title = feishuIssueTitle(text)
	}
	issue, err := qtx.CreateIssue(r.Context(), db.CreateIssueParams{
		WorkspaceID:   agent.WorkspaceID,
		Title:         title,
		Description:   pgtype.Text{String: description, Valid: true},
		Status:        "todo",
		Priority:      "none",
		AssigneeType:  pgtype.Text{String: "agent", Valid: true},
		AssigneeID:    agent.ID,
		CreatorType:   "agent",
		CreatorID:     agent.ID,
		ParentIssueID: pgtype.UUID{},
		Position:      0,
		Number:        issueNumber,
		CodeContext:   codeContextJSON,
	})
	if err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}

	if _, err := tx.Exec(r.Context(), `UPDATE issue SET context_refs = $2 WHERE id = $1`, issue.ID, contextRefsJSON); err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}
	issue.ContextRefs = contextRefsJSON

	if err := tx.Commit(r.Context()); err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}

	task, err := h.TaskService.EnqueueTaskForIssue(r.Context(), issue)
	if err != nil {
		return db.Issue{}, db.AgentTaskQueue{}, err
	}
	workspaceID := uuidToString(issue.WorkspaceID)
	prefix := h.getIssuePrefix(r.Context(), issue.WorkspaceID)
	h.publish(protocol.EventIssueCreated, workspaceID, "agent", uuidToString(agent.ID), map[string]any{"issue": issueToResponse(issue, prefix)})
	return issue, task, nil
}

func feishuContextRef(payload feishuEventCallback, raw []byte) map[string]any {
	return map[string]any{
		"type":         "feishu_message",
		"event_id":     payload.Header.EventID,
		"event_type":   payload.Header.EventType,
		"message_id":   payload.Event.Message.MessageID,
		"root_id":      payload.Event.Message.RootID,
		"parent_id":    payload.Event.Message.ParentID,
		"chat_id":      payload.Event.Message.ChatID,
		"chat_type":    payload.Event.Message.ChatType,
		"message_type": payload.Event.Message.MessageType,
		"create_time":  payload.Event.Message.CreateTime,
		"sender":       payload.Event.Sender,
		"tenant_key":   firstNonEmpty(payload.Header.TenantKey, payload.Event.Sender.TenantKey),
		"raw_event":    json.RawMessage(bytes.TrimSpace(raw)),
	}
}

func buildFeishuIssueDescription(payload feishuEventCallback, text string, codeContext any, decision feishuDifyDecision) string {
	var b strings.Builder
	if strings.TrimSpace(decision.AgentPrompt) != "" {
		b.WriteString("# Agent Prompt\n\n")
		b.WriteString(strings.TrimSpace(decision.AgentPrompt))
		b.WriteString("\n\n---\n\n")
	}
	b.WriteString("# User Request\n\n")
	if strings.TrimSpace(decision.IssueDescription) != "" {
		b.WriteString(strings.TrimSpace(decision.IssueDescription))
		b.WriteString("\n\nOriginal message:\n\n")
	}
	b.WriteString(strings.TrimSpace(text))
	if decision.Action != "" {
		b.WriteString("\n\n---\n\n# Dify Decision\n\n")
		fmt.Fprintf(&b, "- Action: `%s`\n", decision.Action)
		fmt.Fprintf(&b, "- Task Kind: `%s`\n", decision.TaskKind)
		fmt.Fprintf(&b, "- Confidence: `%.2f`\n", decision.Confidence)
		if decision.Reason != "" {
			fmt.Fprintf(&b, "- Reason: %s\n", decision.Reason)
		}
		if decision.Category != "" {
			fmt.Fprintf(&b, "- Category: %s\n", decision.Category)
		}
	}
	b.WriteString("\n\n---\n\n# Feishu Context\n\n")
	fmt.Fprintf(&b, "- Message ID: `%s`\n", payload.Event.Message.MessageID)
	fmt.Fprintf(&b, "- Event ID: `%s`\n", payload.Header.EventID)
	fmt.Fprintf(&b, "- Chat ID: `%s`\n", payload.Event.Message.ChatID)
	fmt.Fprintf(&b, "- Sender Open ID: `%s`\n", payload.Event.Sender.SenderID.OpenID)
	fmt.Fprintf(&b, "- Sender User ID: `%s`\n", payload.Event.Sender.SenderID.UserID)
	fmt.Fprintf(&b, "- Sender Union ID: `%s`\n", payload.Event.Sender.SenderID.UnionID)
	if payload.Event.Message.RootID != "" {
		fmt.Fprintf(&b, "- Root ID: `%s`\n", payload.Event.Message.RootID)
	}
	if payload.Event.Message.ParentID != "" {
		fmt.Fprintf(&b, "- Parent ID: `%s`\n", payload.Event.Message.ParentID)
	}
	encoded, _ := json.Marshal(codeContext)
	if len(encoded) > 0 {
		fmt.Fprintf(&b, "- Code Context: `%s`\n", string(encoded))
	}
	b.WriteString("\n后续如果需要回复或拉取更多会话，可使用以上飞书消息元数据。\n")
	return b.String()
}

const (
	feishuDifyActionIgnore              = "ignore"
	feishuDifyActionReplyOnly           = "reply_only"
	feishuDifyActionCreateIssue         = "create_issue"
	feishuDifyActionReplyAndCreateIssue = "reply_and_create_issue"
	feishuDifyActionAskClarify          = "ask_clarify"
)

type feishuDifyDecision struct {
	Action            string  `json:"action"`
	TaskKind          string  `json:"task_kind"`
	ShouldCreateIssue bool    `json:"should_create_issue"`
	ShouldReply       bool    `json:"should_reply"`
	ReplyText         string  `json:"reply_text"`
	MentionOwner      bool    `json:"mention_owner"`
	IssueTitle        string  `json:"issue_title"`
	IssueDescription  string  `json:"issue_description"`
	AgentPrompt       string  `json:"agent_prompt"`
	AgentKey          string  `json:"agent_key"`
	Confidence        float64 `json:"confidence"`
	Reason            string  `json:"reason"`
	Category          string  `json:"category"`
	RawJSON           string  `json:"raw_json"`
}

func (h *Handler) decideFeishuMessageWithDify(ctx context.Context, cfg feishuConfig, agent db.Agent, payload feishuEventCallback, messageText string, ownerMentioned bool) (feishuDifyDecision, error) {
	if cfg.DifyAPIKey == "" {
		return feishuFallbackDecision(messageText), nil
	}

	mentionsJSON, _ := json.Marshal(feishuMessageMentions(payload.Event.Message))
	reqBody, err := json.Marshal(map[string]any{
		"inputs": map[string]any{
			"message_text":       messageText,
			"raw_content":        payload.Event.Message.Content,
			"chat_type":          payload.Event.Message.ChatType,
			"chat_id":            payload.Event.Message.ChatID,
			"message_id":         payload.Event.Message.MessageID,
			"sender_open_id":     payload.Event.Sender.SenderID.OpenID,
			"sender_user_id":     payload.Event.Sender.SenderID.UserID,
			"sender_name":        "",
			"owner_open_id":      cfg.AllowedOpenID,
			"owner_user_id":      cfg.AllowedUserID,
			"owner_name":         cfg.OwnerName,
			"owner_mentioned":    fmt.Sprintf("%t", ownerMentioned),
			"mentions_json":      string(mentionsJSON),
			"workspace_slug":     "",
			"default_agent_name": agent.Name,
		},
		"response_mode": "blocking",
		"user":          cfg.DifyUser,
	})
	if err != nil {
		return feishuDifyDecision{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	baseURL := strings.TrimRight(cfg.DifyBaseURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/workflows/run", bytes.NewReader(reqBody))
	if err != nil {
		return feishuDifyDecision{}, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.DifyAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return feishuDifyDecision{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return feishuDifyDecision{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return feishuDifyDecision{}, fmt.Errorf("dify workflow status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var parsed struct {
		Data struct {
			Outputs feishuDifyDecision `json:"outputs"`
			Error   string             `json:"error"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return feishuDifyDecision{}, err
	}
	if parsed.Data.Error != "" {
		return feishuDifyDecision{}, fmt.Errorf("dify workflow error: %s", parsed.Data.Error)
	}
	decision := normalizeFeishuDifyDecision(parsed.Data.Outputs, messageText)
	if decision.RawJSON == "" {
		decision.RawJSON = string(bytes.TrimSpace(respBody))
	}
	return decision, nil
}

func feishuFallbackDecision(messageText string) feishuDifyDecision {
	return normalizeFeishuDifyDecision(feishuDifyDecision{
		Action:            feishuDifyActionCreateIssue,
		TaskKind:          "general_question",
		ShouldCreateIssue: true,
		ShouldReply:       true,
		ReplyText:         "",
		IssueTitle:        feishuIssueTitle(messageText),
		IssueDescription:  strings.TrimSpace(messageText),
		AgentPrompt:       strings.TrimSpace(messageText),
		AgentKey:          "default",
		Confidence:        0,
		Reason:            "Dify is not configured; used legacy Feishu behavior",
	}, messageText)
}

func normalizeFeishuDifyDecision(decision feishuDifyDecision, messageText string) feishuDifyDecision {
	decision.Action = strings.TrimSpace(decision.Action)
	if decision.Action == "" {
		decision.Action = feishuDifyActionIgnore
	}
	switch decision.Action {
	case feishuDifyActionIgnore, feishuDifyActionReplyOnly, feishuDifyActionCreateIssue, feishuDifyActionReplyAndCreateIssue, feishuDifyActionAskClarify:
	default:
		decision.Action = feishuDifyActionIgnore
	}
	decision.TaskKind = strings.TrimSpace(decision.TaskKind)
	if decision.TaskKind == "" {
		decision.TaskKind = "none"
	}
	decision.ReplyText = strings.TrimSpace(decision.ReplyText)
	decision.IssueTitle = strings.TrimSpace(decision.IssueTitle)
	decision.IssueDescription = strings.TrimSpace(decision.IssueDescription)
	decision.AgentPrompt = strings.TrimSpace(decision.AgentPrompt)
	decision.AgentKey = firstNonEmpty(decision.AgentKey, "default")
	if decision.Confidence < 0 {
		decision.Confidence = 0
	}
	if decision.Confidence > 1 {
		decision.Confidence = 1
	}

	if decision.Action == feishuDifyActionIgnore {
		decision.TaskKind = "none"
		decision.ShouldCreateIssue = false
		decision.ShouldReply = false
		decision.ReplyText = ""
		return decision
	}
	decision.ShouldCreateIssue = decision.ShouldCreateIssue || decision.Action == feishuDifyActionCreateIssue || decision.Action == feishuDifyActionReplyAndCreateIssue
	decision.ShouldReply = decision.ShouldReply || decision.Action == feishuDifyActionReplyOnly || decision.Action == feishuDifyActionReplyAndCreateIssue || decision.Action == feishuDifyActionAskClarify
	if decision.Action == feishuDifyActionCreateIssue && decision.ReplyText != "" {
		decision.ShouldReply = true
	}
	if decision.ShouldCreateIssue {
		if decision.IssueTitle == "" {
			decision.IssueTitle = feishuIssueTitle(messageText)
		}
		if decision.AgentPrompt == "" {
			decision.AgentPrompt = strings.TrimSpace(messageText)
		}
	}
	return decision
}

func feishuIssueTitle(text string) string {
	trimmed := strings.Join(strings.Fields(text), " ")
	if trimmed == "" {
		return "Feishu message"
	}
	runes := []rune(trimmed)
	if len(runes) > 80 {
		return string(runes[:80]) + "…"
	}
	return trimmed
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func secureEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
