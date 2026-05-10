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
	Text string `json:"text"`
}

func (h *Handler) FeishuWebhook(w http.ResponseWriter, r *http.Request) {
	config := feishuConfigFromEnv()
	if config.WebhookToken == "" || config.FixedAgentID == "" {
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

	if payload.Challenge != "" {
		if !secureEqual(firstNonEmpty(payload.Token, payload.Header.Token), config.WebhookToken) {
			writeError(w, http.StatusUnauthorized, "invalid feishu token")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"challenge": payload.Challenge})
		return
	}

	if !secureEqual(firstNonEmpty(payload.Header.Token, payload.Token), config.WebhookToken) {
		writeError(w, http.StatusUnauthorized, "invalid feishu token")
		return
	}

	eventType := firstNonEmpty(payload.Header.EventType, payload.Type)
	if eventType != "im.message.receive_v1" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "unsupported_event_type"})
		return
	}
	if config.AllowedChatID != "" && payload.Event.Message.ChatID != config.AllowedChatID {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "chat_not_allowed"})
		return
	}
	if !feishuSenderAllowed(payload.Event.Sender.SenderID, config) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "sender_not_allowed"})
		return
	}

	agentID, err := util.ParseUUID(config.FixedAgentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid fixed feishu agent id")
		return
	}
	agent, err := h.Queries.GetAgent(r.Context(), agentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "fixed feishu agent not found")
		return
	}
	if agent.ArchivedAt.Valid {
		writeError(w, http.StatusConflict, "fixed feishu agent is archived")
		return
	}

	feishuMessageID := strings.TrimSpace(payload.Event.Message.MessageID)
	if feishuMessageID == "" {
		feishuMessageID = strings.TrimSpace(payload.Header.EventID)
	}
	if feishuMessageID == "" {
		writeError(w, http.StatusBadRequest, "message_id is required")
		return
	}

	if existing, found, err := h.findIssueByFeishuMessageID(r.Context(), agent.WorkspaceID, feishuMessageID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check duplicate feishu message")
		return
	} else if found {
		writeJSON(w, http.StatusOK, map[string]any{"status": "duplicate", "issue_id": uuidToString(existing.ID)})
		return
	}

	messageText := feishuMessageText(payload.Event.Message)
	if strings.TrimSpace(messageText) == "" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "empty_message"})
		return
	}

	issue, task, err := h.createIssueFromFeishu(r, agent, payload, messageText, body)
	if err != nil {
		slog.Warn("create issue from feishu failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create issue from feishu")
		return
	}

	if h.Feishu != nil && h.Feishu.Enabled() && payload.Event.Message.MessageID != "" {
		ackText := fmt.Sprintf("已收到，已创建 %s：%s\n智能体：%s\n我会开始处理，完成后可以继续回复这里。", h.issueIdentifier(r.Context(), issue), issue.Title, agent.Name)
		if ack, err := h.Feishu.ReplyText(r.Context(), payload.Event.Message.MessageID, ackText); err != nil {
			slog.Warn("feishu ack reply failed", append(logger.RequestAttrs(r), "error", err, "message_id", payload.Event.Message.MessageID, "issue_id", uuidToString(issue.ID))...)
		} else if ack.MessageID != "" {
			h.appendFeishuAckContext(r.Context(), issue.ID, ack.MessageID)
		}
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":   "queued",
		"issue_id": uuidToString(issue.ID),
		"task_id":  uuidToString(task.ID),
	})
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
}

func feishuConfigFromEnv() feishuConfig {
	return feishuConfig{
		WebhookToken:   strings.TrimSpace(os.Getenv("FEISHU_WEBHOOK_TOKEN")),
		FixedAgentID:   strings.TrimSpace(os.Getenv("FEISHU_FIXED_AGENT_ID")),
		AllowedChatID:  strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_CHAT_ID")),
		AllowedOpenID:  strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_OPEN_ID")),
		AllowedUserID:  strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_USER_ID")),
		AllowedUnionID: strings.TrimSpace(os.Getenv("FEISHU_ALLOWED_UNION_ID")),
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

func (h *Handler) createIssueFromFeishu(r *http.Request, agent db.Agent, payload feishuEventCallback, text string, raw []byte) (db.Issue, db.AgentTaskQueue, error) {
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

	description := buildFeishuIssueDescription(payload, text, codeContext)
	issue, err := qtx.CreateIssue(r.Context(), db.CreateIssueParams{
		WorkspaceID:   agent.WorkspaceID,
		Title:         feishuIssueTitle(text),
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

func buildFeishuIssueDescription(payload feishuEventCallback, text string, codeContext any) string {
	var b strings.Builder
	b.WriteString("# User Request\n\n")
	b.WriteString(strings.TrimSpace(text))
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
