package handler

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
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
	SignatureConfigured   bool     `json:"signature_configured"`
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

type FeishuMessageLogResponse struct {
	InboxItemID     string  `json:"inbox_item_id"`
	WorkspaceID     string  `json:"workspace_id"`
	RecipientID     string  `json:"recipient_id"`
	InboxTitle      string  `json:"inbox_title"`
	InboundText     string  `json:"inbound_text"`
	Read            bool    `json:"read"`
	Archived        bool    `json:"archived"`
	ReceivedAt      string  `json:"received_at"`
	MessageID       string  `json:"message_id"`
	EventID         string  `json:"event_id"`
	ChatID          string  `json:"chat_id"`
	ChatType        string  `json:"chat_type"`
	SenderOpenID    string  `json:"sender_open_id"`
	SenderUserID    string  `json:"sender_user_id"`
	SenderUnionID   string  `json:"sender_union_id"`
	GateReason      string  `json:"gate_reason"`
	ApprovalID      string  `json:"approval_id"`
	ApprovalStatus  string  `json:"approval_status"`
	RiskLevel       string  `json:"risk_level"`
	ExecutionStatus string  `json:"execution_status"`
	ExecutionError  string  `json:"execution_error"`
	ApprovedAt      *string `json:"approved_at"`
	ExecutedAt      *string `json:"executed_at"`
	ReplyText       string  `json:"reply_text"`
	DraftSource     string  `json:"draft_source"`
	DraftProvider   string  `json:"draft_provider"`
	DraftModel      string  `json:"draft_model"`
	QualityScore    int32   `json:"quality_score"`
	QualityNote     string  `json:"quality_note"`
	QualityScoredAt *string `json:"quality_scored_at"`
}

type FeishuDogfoodSummaryResponse struct {
	TotalReceived    int64   `json:"total_received"`
	ReceivedToday    int64   `json:"received_today"`
	ApprovalsCreated int64   `json:"approvals_created"`
	PendingApproval  int64   `json:"pending_approval"`
	Rejected         int64   `json:"rejected"`
	Sent             int64   `json:"sent"`
	SendFailed       int64   `json:"send_failed"`
	AIDrafted        int64   `json:"ai_drafted"`
	QualityReviewed  int64   `json:"quality_reviewed"`
	AvgQualityScore  float64 `json:"avg_quality_score"`
	DogfoodTarget    int64   `json:"dogfood_target"`
	DogfoodCompleted int64   `json:"dogfood_completed"`
	DogfoodRemaining int64   `json:"dogfood_remaining"`
	FirstReceivedAt  *string `json:"first_received_at"`
	LastReceivedAt   *string `json:"last_received_at"`
}

type AIMeCostControlResponse struct {
	Currency                string `json:"currency"`
	DraftCallCount          int64  `json:"draft_call_count"`
	EstimatedDraftCostCents int64  `json:"estimated_draft_cost_cents"`
	DailyBudgetCents        int64  `json:"daily_budget_cents"`
	RemainingBudgetCents    int64  `json:"remaining_budget_cents"`
	BudgetStatus            string `json:"budget_status"`
	WorkerTaskCount         int64  `json:"worker_task_count"`
	WorkerInputTokens       int64  `json:"worker_input_tokens"`
	WorkerOutputTokens      int64  `json:"worker_output_tokens"`
	WorkerCacheReadTokens   int64  `json:"worker_cache_read_tokens"`
	WorkerCacheWriteTokens  int64  `json:"worker_cache_write_tokens"`
}

type FeishuReliabilitySummaryResponse struct {
	WebhookEvents           int64   `json:"webhook_events"`
	DuplicateEvents         int64   `json:"duplicate_events"`
	AcceptedEvents          int64   `json:"accepted_events"`
	IgnoredEvents           int64   `json:"ignored_events"`
	FailedEvents            int64   `json:"failed_events"`
	RejectedEvents          int64   `json:"rejected_events"`
	SignatureVerifiedEvents int64   `json:"signature_verified_events"`
	ReplayProtectedEvents   int64   `json:"replay_protected_events"`
	EventsToday             int64   `json:"events_today"`
	LastEventAt             *string `json:"last_event_at"`
}

type FeishuDeliverySummaryResponse struct {
	Deliveries     int64   `json:"deliveries"`
	Sending        int64   `json:"sending"`
	Succeeded      int64   `json:"succeeded"`
	Failed         int64   `json:"failed"`
	DeadLetter     int64   `json:"dead_letter"`
	Attempts       int64   `json:"attempts"`
	LastDeliveryAt *string `json:"last_delivery_at"`
}

type AIMeQualitySummaryResponse struct {
	Reviewed       int64   `json:"reviewed"`
	AvgScore       float64 `json:"avg_score"`
	Good           int64   `json:"good"`
	Poor           int64   `json:"poor"`
	Accepted       int64   `json:"accepted"`
	NeedsRetry     int64   `json:"needs_retry"`
	Wrong          int64   `json:"wrong"`
	LastReviewedAt *string `json:"last_reviewed_at"`
}

type AIMeModelRoutingResponse struct {
	DefaultProvider        string   `json:"default_provider"`
	DefaultModel           string   `json:"default_model"`
	DraftProvider          string   `json:"draft_provider"`
	DraftModel             string   `json:"draft_model"`
	WorkerPolicy           string   `json:"worker_policy"`
	DailyBudgetCents       int64    `json:"daily_budget_cents"`
	BudgetStatus           string   `json:"budget_status"`
	RecommendedNextActions []string `json:"recommended_next_actions"`
}

type FeishuDogfoodChecklistItemResponse struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Completed   bool   `json:"completed"`
}

type FeishuDogfoodCaseResponse struct {
	Slot           int32   `json:"slot"`
	MessageID      string  `json:"message_id"`
	ApprovalID     string  `json:"approval_id"`
	Title          string  `json:"title"`
	Stage          string  `json:"stage"`
	Completed      bool    `json:"completed"`
	BlockingReason string  `json:"blocking_reason"`
	ReceivedAt     *string `json:"received_at"`
}

type FeishuWebhookEventResponse struct {
	ID                string  `json:"id"`
	EventKey          string  `json:"event_key"`
	EventID           string  `json:"event_id"`
	MessageID         string  `json:"message_id"`
	EventType         string  `json:"event_type"`
	Status            string  `json:"status"`
	Reason            string  `json:"reason"`
	SignatureVerified bool    `json:"signature_verified"`
	TokenVerified     bool    `json:"token_verified"`
	ReplayProtected   bool    `json:"replay_protected"`
	DuplicateCount    int32   `json:"duplicate_count"`
	RequestTimestamp  *string `json:"request_timestamp"`
	InboxItemID       *string `json:"inbox_item_id"`
	ApprovalID        *string `json:"approval_id"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
}

type FeishuDeliveryResponse struct {
	ID              string  `json:"id"`
	ApprovalID      *string `json:"approval_id"`
	SourceMessageID string  `json:"source_message_id"`
	ReplyMessageID  string  `json:"reply_message_id"`
	Status          string  `json:"status"`
	AttemptCount    int32   `json:"attempt_count"`
	LastError       string  `json:"last_error"`
	NextRetryAt     *string `json:"next_retry_at"`
	SentAt          *string `json:"sent_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type AIMeOnboardingStepResponse struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Completed   bool   `json:"completed"`
}

type AIMeOnboardingResponse struct {
	Completed      bool                         `json:"completed"`
	CompletedSteps int                          `json:"completed_steps"`
	TotalSteps     int                          `json:"total_steps"`
	Steps          []AIMeOnboardingStepResponse `json:"steps"`
}

type FeishuDogfoodPanelResponse struct {
	Status      FeishuIntegrationStatusResponse      `json:"status"`
	Summary     FeishuDogfoodSummaryResponse         `json:"summary"`
	Cost        AIMeCostControlResponse              `json:"cost"`
	Reliability FeishuReliabilitySummaryResponse     `json:"reliability"`
	Delivery    FeishuDeliverySummaryResponse        `json:"delivery"`
	Quality     AIMeQualitySummaryResponse           `json:"quality"`
	ModelRoute  AIMeModelRoutingResponse             `json:"model_route"`
	Onboarding  AIMeOnboardingResponse               `json:"onboarding"`
	Checklist   []FeishuDogfoodChecklistItemResponse `json:"checklist"`
	Cases       []FeishuDogfoodCaseResponse          `json:"cases"`
	Logs        []FeishuMessageLogResponse           `json:"logs"`
	Events      []FeishuWebhookEventResponse         `json:"events"`
	Deliveries  []FeishuDeliveryResponse             `json:"deliveries"`
}

func (h *Handler) GetFeishuIntegrationStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	writeJSON(w, http.StatusOK, h.buildFeishuIntegrationStatus(r.Context(), workspaceUUID, workspaceID))
}

func (h *Handler) buildFeishuIntegrationStatus(ctx context.Context, workspaceUUID pgtype.UUID, workspaceID string) FeishuIntegrationStatusResponse {
	cfg := feishuConfigFromEnv()
	mode := feishuEventModeFromEnv()
	webhookConfigured := cfg.WebhookToken != ""
	signatureConfigured := cfg.EncryptKey != ""
	appConfigured := feishuAppCredentialsConfigured()
	workspaceConfigured := cfg.WorkspaceID != "" || cfg.WorkspaceSlug != ""
	workspaceMatches, workspaceWarnings := h.feishuWorkspaceMatches(ctx, workspaceUUID, workspaceID, cfg)
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
	if mode == "webhook" && !signatureConfigured {
		warnings = append(warnings, "webhook_signature_not_configured")
	}
	if mode == "websocket" && !appConfigured {
		warnings = append(warnings, "app_credentials_missing")
	}
	if !outgoingConfigured {
		warnings = append(warnings, "reply_client_not_configured")
	}

	return FeishuIntegrationStatusResponse{
		Provider:              "feishu",
		EventMode:             mode,
		IncomingConfigured:    incomingConfigured,
		OutgoingConfigured:    outgoingConfigured,
		WebhookConfigured:     webhookConfigured,
		SignatureConfigured:   signatureConfigured,
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
	}
}

func (h *Handler) ListFeishuLogs(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	limit, offset := feishuLogPagination(r)
	logs, err := h.Queries.ListFeishuMessageLogs(r.Context(), db.ListFeishuMessageLogsParams{
		WorkspaceID: workspaceUUID,
		Limit:       limit,
		Offset:      offset,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list feishu logs")
		return
	}
	caseRows, err := h.Queries.ListFeishuMessageLogs(r.Context(), db.ListFeishuMessageLogsParams{
		WorkspaceID: workspaceUUID,
		Limit:       20,
		Offset:      0,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load feishu dogfood cases")
		return
	}
	summary, err := h.Queries.GetFeishuDogfoodSummary(r.Context(), db.GetFeishuDogfoodSummaryParams{
		WorkspaceID:    workspaceUUID,
		DraftCostCents: aimeDraftCostCentsFromEnv(),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load feishu summary")
		return
	}
	workerUsage, err := h.Queries.GetAIMeWorkerUsageSummary(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load AI-Me usage summary")
		return
	}
	reliability, err := h.Queries.GetFeishuReliabilitySummary(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load feishu reliability summary")
		return
	}
	delivery, err := h.Queries.GetFeishuDeliverySummary(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load feishu delivery summary")
		return
	}
	quality, err := h.Queries.GetAIApprovalQualitySummary(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load AI-Me quality summary")
		return
	}
	events, err := h.Queries.ListFeishuWebhookEvents(r.Context(), db.ListFeishuWebhookEventsParams{
		WorkspaceID: workspaceUUID,
		Limit:       12,
		Offset:      0,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list feishu webhook events")
		return
	}
	deliveries, err := h.Queries.ListFeishuDeliveries(r.Context(), db.ListFeishuDeliveriesParams{
		WorkspaceID: workspaceUUID,
		Limit:       12,
		Offset:      0,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list feishu deliveries")
		return
	}
	status := h.buildFeishuIntegrationStatus(r.Context(), workspaceUUID, workspaceID)
	onboarding, err := h.buildAIMeOnboardingResponse(r.Context(), workspaceUUID, status)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load AI-Me onboarding status")
		return
	}
	summaryResp := feishuDogfoodSummaryToResponse(summary)
	costResp := aimeCostControlToResponse(summary, workerUsage)
	reliabilityResp := feishuReliabilitySummaryToResponse(reliability)
	deliveryResp := feishuDeliverySummaryToResponse(delivery)
	qualityResp := aimeQualitySummaryToResponse(quality)
	writeJSON(w, http.StatusOK, FeishuDogfoodPanelResponse{
		Status:      status,
		Summary:     summaryResp,
		Cost:        costResp,
		Reliability: reliabilityResp,
		Delivery:    deliveryResp,
		Quality:     qualityResp,
		ModelRoute:  buildAIMeModelRoutingResponse(status, costResp),
		Onboarding:  onboarding,
		Checklist:   buildFeishuDogfoodChecklist(status, summaryResp, reliabilityResp, deliveryResp, qualityResp),
		Cases:       buildFeishuDogfoodCases(feishuLogsToResponse(caseRows), 20),
		Logs:        feishuLogsToResponse(logs),
		Events:      feishuWebhookEventsToResponse(events),
		Deliveries:  feishuDeliveriesToResponse(deliveries),
	})
}

func buildFeishuDogfoodCases(logs []FeishuMessageLogResponse, target int) []FeishuDogfoodCaseResponse {
	if target <= 0 {
		return []FeishuDogfoodCaseResponse{}
	}
	if len(logs) > target {
		logs = logs[:target]
	}
	ordered := make([]FeishuMessageLogResponse, len(logs))
	for i := range logs {
		ordered[len(logs)-1-i] = logs[i]
	}
	cases := make([]FeishuDogfoodCaseResponse, target)
	for i := 0; i < target; i++ {
		caseResp := FeishuDogfoodCaseResponse{
			Slot:           int32(i + 1),
			Title:          "等待真实飞书消息",
			Stage:          "awaiting_message",
			BlockingReason: "等待同事从飞书发送真实消息",
		}
		if i < len(ordered) {
			log := ordered[i]
			stage, completed, blockingReason := feishuDogfoodCaseStatus(log)
			receivedAt := log.ReceivedAt
			caseResp = FeishuDogfoodCaseResponse{
				Slot:           int32(i + 1),
				MessageID:      log.MessageID,
				ApprovalID:     log.ApprovalID,
				Title:          firstNonEmpty(log.InboxTitle, "飞书消息"),
				Stage:          stage,
				Completed:      completed,
				BlockingReason: blockingReason,
				ReceivedAt:     &receivedAt,
			}
		}
		cases[i] = caseResp
	}
	return cases
}

func feishuDogfoodCaseStatus(log FeishuMessageLogResponse) (string, bool, string) {
	if log.ApprovalID == "" {
		return "received", false, "等待 AI-Me 创建审批"
	}
	if log.ApprovalStatus == "pending" || log.ApprovalStatus == "observing" {
		return "pending_approval", false, "等待人工审批"
	}
	if log.ApprovalStatus == "rejected" {
		if log.QualityScore > 0 {
			return "reviewed", true, ""
		}
		return "awaiting_review", false, "已驳回，等待质量复盘"
	}
	if log.ExecutionStatus == "failed" {
		return "send_failed", false, firstNonEmpty(log.ExecutionError, "发送失败，等待自动重试或人工恢复")
	}
	if log.ExecutionStatus == "running" {
		return "sending", false, "飞书回复发送中"
	}
	if log.ExecutionStatus == "succeeded" {
		if log.QualityScore > 0 {
			return "reviewed", true, ""
		}
		return "awaiting_review", false, "发送成功，等待质量复盘"
	}
	if log.ApprovalStatus == "approved" {
		return "awaiting_send", false, "审批已通过，等待发送"
	}
	return "received", false, "等待 AI-Me 推进"
}

func (h *Handler) GetAIMeOnboardingStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	status := h.buildFeishuIntegrationStatus(r.Context(), workspaceUUID, workspaceID)
	onboarding, err := h.buildAIMeOnboardingResponse(r.Context(), workspaceUUID, status)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load AI-Me onboarding status")
		return
	}
	writeJSON(w, http.StatusOK, onboarding)
}

func feishuLogPagination(r *http.Request) (int32, int32) {
	limit := int32(30)
	offset := int32(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 100 {
			limit = int32(parsed)
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = int32(parsed)
		}
	}
	return limit, offset
}

func feishuLogsToResponse(rows []db.ListFeishuMessageLogsRow) []FeishuMessageLogResponse {
	resp := make([]FeishuMessageLogResponse, len(rows))
	for i, row := range rows {
		resp[i] = FeishuMessageLogResponse{
			InboxItemID:     uuidToString(row.InboxItemID),
			WorkspaceID:     uuidToString(row.WorkspaceID),
			RecipientID:     uuidToString(row.RecipientID),
			InboxTitle:      row.InboxTitle,
			InboundText:     row.InboundText,
			Read:            row.Read,
			Archived:        row.Archived,
			ReceivedAt:      timestampToString(row.ReceivedAt),
			MessageID:       row.MessageID,
			EventID:         row.EventID,
			ChatID:          row.ChatID,
			ChatType:        row.ChatType,
			SenderOpenID:    row.SenderOpenID,
			SenderUserID:    row.SenderUserID,
			SenderUnionID:   row.SenderUnionID,
			GateReason:      row.GateReason,
			ApprovalID:      row.ApprovalID,
			ApprovalStatus:  row.ApprovalStatus,
			RiskLevel:       row.RiskLevel,
			ExecutionStatus: row.ExecutionStatus,
			ExecutionError:  row.ExecutionError,
			ApprovedAt:      timestampToPtr(row.ApprovedAt),
			ExecutedAt:      timestampToPtr(row.ExecutedAt),
			ReplyText:       row.ReplyText,
			DraftSource:     row.DraftSource,
			DraftProvider:   row.DraftProvider,
			DraftModel:      row.DraftModel,
			QualityScore:    row.QualityScore,
			QualityNote:     row.QualityNote,
			QualityScoredAt: timestampToPtr(row.QualityScoredAt),
		}
	}
	return resp
}

func feishuDogfoodSummaryToResponse(row db.GetFeishuDogfoodSummaryRow) FeishuDogfoodSummaryResponse {
	return FeishuDogfoodSummaryResponse{
		TotalReceived:    row.TotalReceived,
		ReceivedToday:    row.ReceivedToday,
		ApprovalsCreated: row.ApprovalsCreated,
		PendingApproval:  row.PendingApproval,
		Rejected:         row.Rejected,
		Sent:             row.Sent,
		SendFailed:       row.SendFailed,
		AIDrafted:        row.AiDrafted,
		QualityReviewed:  row.QualityReviewed,
		AvgQualityScore:  row.AvgQualityScore,
		DogfoodTarget:    20,
		DogfoodCompleted: row.DogfoodCompleted,
		DogfoodRemaining: row.DogfoodRemaining,
		FirstReceivedAt:  timestampToPtr(row.FirstReceivedAt),
		LastReceivedAt:   timestampToPtr(row.LastReceivedAt),
	}
}

func aimeCostControlToResponse(summary db.GetFeishuDogfoodSummaryRow, worker db.GetAIMeWorkerUsageSummaryRow) AIMeCostControlResponse {
	budget := aimeDailyBudgetCentsFromEnv()
	used := summary.EstimatedDraftCostCents
	remaining := budget - used
	if remaining < 0 {
		remaining = 0
	}
	status := "ok"
	if budget > 0 && used >= budget {
		status = "exceeded"
	} else if budget > 0 && used*100 >= budget*80 {
		status = "warning"
	}
	return AIMeCostControlResponse{
		Currency:                "USD",
		DraftCallCount:          summary.AiDrafted,
		EstimatedDraftCostCents: used,
		DailyBudgetCents:        budget,
		RemainingBudgetCents:    remaining,
		BudgetStatus:            status,
		WorkerTaskCount:         worker.TaskCount,
		WorkerInputTokens:       worker.InputTokens,
		WorkerOutputTokens:      worker.OutputTokens,
		WorkerCacheReadTokens:   worker.CacheReadTokens,
		WorkerCacheWriteTokens:  worker.CacheWriteTokens,
	}
}

func feishuReliabilitySummaryToResponse(row db.GetFeishuReliabilitySummaryRow) FeishuReliabilitySummaryResponse {
	return FeishuReliabilitySummaryResponse{
		WebhookEvents:           row.WebhookEvents,
		DuplicateEvents:         row.DuplicateEvents,
		AcceptedEvents:          row.AcceptedEvents,
		IgnoredEvents:           row.IgnoredEvents,
		FailedEvents:            row.FailedEvents,
		RejectedEvents:          row.RejectedEvents,
		SignatureVerifiedEvents: row.SignatureVerifiedEvents,
		ReplayProtectedEvents:   row.ReplayProtectedEvents,
		EventsToday:             row.EventsToday,
		LastEventAt:             timestampToPtr(row.LastEventAt),
	}
}

func feishuDeliverySummaryToResponse(row db.GetFeishuDeliverySummaryRow) FeishuDeliverySummaryResponse {
	return FeishuDeliverySummaryResponse{
		Deliveries:     row.Deliveries,
		Sending:        row.Sending,
		Succeeded:      row.Succeeded,
		Failed:         row.Failed,
		DeadLetter:     row.DeadLetter,
		Attempts:       row.Attempts,
		LastDeliveryAt: timestampToPtr(row.LastDeliveryAt),
	}
}

func aimeQualitySummaryToResponse(row db.GetAIApprovalQualitySummaryRow) AIMeQualitySummaryResponse {
	return AIMeQualitySummaryResponse{
		Reviewed:       row.Reviewed,
		AvgScore:       row.AvgScore,
		Good:           row.Good,
		Poor:           row.Poor,
		Accepted:       row.Accepted,
		NeedsRetry:     row.NeedsRetry,
		Wrong:          row.Wrong,
		LastReviewedAt: timestampToPtr(row.LastReviewedAt),
	}
}

func buildAIMeModelRoutingResponse(status FeishuIntegrationStatusResponse, cost AIMeCostControlResponse) AIMeModelRoutingResponse {
	provider := firstNonEmpty(os.Getenv("AI_ME_LLM_PROVIDER"), os.Getenv("AI_MODEL_PROVIDER"), "deepseek")
	model := firstNonEmpty(os.Getenv("AI_ME_LLM_MODEL"), os.Getenv("AI_MODEL_MODEL"), "deepseek-chat")
	actions := make([]string, 0, 4)
	if !status.OutgoingConfigured {
		actions = append(actions, "配置 FEISHU_APP_ID / FEISHU_APP_SECRET 后才能发送审批通过的回复")
	}
	if !status.SignatureConfigured {
		actions = append(actions, "配置 FEISHU_ENCRYPT_KEY 以启用飞书 Webhook 签名和重放保护")
	}
	if cost.BudgetStatus == "warning" || cost.BudgetStatus == "exceeded" {
		actions = append(actions, "降低草稿模型成本或提高 AI_ME_DAILY_BUDGET_CENTS")
	}
	if len(actions) == 0 {
		actions = append(actions, "保持 DeepSeek 负责草稿，Codex / Claude Code 只承接需要真实执行的员工任务")
	}
	return AIMeModelRoutingResponse{
		DefaultProvider:        provider,
		DefaultModel:           model,
		DraftProvider:          provider,
		DraftModel:             model,
		WorkerPolicy:           "DeepSeek 负责低成本判断和回复草稿；Codex / Claude Code 只在审批后的代码任务中作为员工执行。",
		DailyBudgetCents:       cost.DailyBudgetCents,
		BudgetStatus:           cost.BudgetStatus,
		RecommendedNextActions: actions,
	}
}

func buildFeishuDogfoodChecklist(
	status FeishuIntegrationStatusResponse,
	summary FeishuDogfoodSummaryResponse,
	reliability FeishuReliabilitySummaryResponse,
	delivery FeishuDeliverySummaryResponse,
	quality AIMeQualitySummaryResponse,
) []FeishuDogfoodChecklistItemResponse {
	return []FeishuDogfoodChecklistItemResponse{
		{Key: "connect_incoming", Title: "接入飞书入站", Description: "当前工作区能接收飞书事件。", Completed: status.IncomingConfigured},
		{Key: "signature_enabled", Title: "启用签名防伪", Description: "Webhook 已启用签名校验和时间窗防重放。", Completed: status.SignatureConfigured && reliability.SignatureVerifiedEvents > 0},
		{Key: "first_real_message", Title: "收到第一条真实消息", Description: "飞书消息已进入 AI-Me 收件箱。", Completed: summary.TotalReceived > 0},
		{Key: "approval_created", Title: "生成审批", Description: "AI-Me 已为飞书消息创建可编辑审批。", Completed: summary.ApprovalsCreated > 0},
		{Key: "edited_or_approved", Title: "完成审批动作", Description: "至少有一条飞书审批被批准或拒绝。", Completed: summary.Sent > 0 || summary.Rejected > 0},
		{Key: "reply_sent", Title: "发送成功", Description: "审批通过后已通过飞书机器人回复。", Completed: delivery.Succeeded > 0 || summary.Sent > 0},
		{Key: "retry_observed", Title: "验证失败重试", Description: "发送失败会自动重试，也可从狗粮面板或审批中心人工恢复。", Completed: delivery.Failed > 0 || delivery.DeadLetter > 0 || delivery.Attempts > delivery.Deliveries},
		{Key: "quality_reviewed", Title: "完成质量复盘", Description: "至少为一条 AI-Me 回复打分并记录复盘意见。", Completed: quality.Reviewed > 0},
		{Key: "twenty_messages", Title: "跑满 20 条真实狗粮", Description: "用真实飞书消息连续验证 AI-Me 闭环。", Completed: summary.DogfoodCompleted >= summary.DogfoodTarget},
	}
}

func feishuWebhookEventsToResponse(rows []db.AiMeFeishuWebhookEvent) []FeishuWebhookEventResponse {
	resp := make([]FeishuWebhookEventResponse, len(rows))
	for i, row := range rows {
		resp[i] = FeishuWebhookEventResponse{
			ID:                uuidToString(row.ID),
			EventKey:          row.EventKey,
			EventID:           row.EventID,
			MessageID:         row.MessageID,
			EventType:         row.EventType,
			Status:            row.Status,
			Reason:            row.Reason,
			SignatureVerified: row.SignatureVerified,
			TokenVerified:     row.TokenVerified,
			ReplayProtected:   row.ReplayProtected,
			DuplicateCount:    row.DuplicateCount,
			RequestTimestamp:  timestampToPtr(row.RequestTimestamp),
			InboxItemID:       uuidToPtr(row.InboxItemID),
			ApprovalID:        uuidToPtr(row.ApprovalID),
			CreatedAt:         timestampToString(row.CreatedAt),
			UpdatedAt:         timestampToString(row.UpdatedAt),
		}
	}
	return resp
}

func feishuDeliveriesToResponse(rows []db.AiMeFeishuDelivery) []FeishuDeliveryResponse {
	resp := make([]FeishuDeliveryResponse, len(rows))
	for i, row := range rows {
		resp[i] = FeishuDeliveryResponse{
			ID:              uuidToString(row.ID),
			ApprovalID:      uuidToPtr(row.ApprovalID),
			SourceMessageID: row.SourceMessageID,
			ReplyMessageID:  row.ReplyMessageID,
			Status:          row.Status,
			AttemptCount:    row.AttemptCount,
			LastError:       row.LastError,
			NextRetryAt:     timestampToPtr(row.NextRetryAt),
			SentAt:          timestampToPtr(row.SentAt),
			UpdatedAt:       timestampToString(row.UpdatedAt),
		}
	}
	return resp
}

// RetryDueFeishuDeliveries claims and retries due Feishu deliveries once.
// The database claim prevents multiple API nodes from sending the same reply.
func (h *Handler) RetryDueFeishuDeliveries(ctx context.Context, limit int32) (int, error) {
	if h.Queries == nil {
		return 0, fmt.Errorf("database queries are not configured")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	deliveries, err := h.Queries.ClaimDueFeishuDeliveries(ctx, db.ClaimDueFeishuDeliveriesParams{
		StaleAfterSeconds: int32FromEnv("AI_ME_FEISHU_SENDING_LEASE_SECONDS", 60),
		Limit:             limit,
	})
	if err != nil {
		return 0, fmt.Errorf("claim due feishu deliveries: %w", err)
	}
	processed := 0
	for _, delivery := range deliveries {
		if !delivery.ApprovalID.Valid {
			slog.Warn("飞书自动重试跳过无审批记录", "delivery_id", uuidToString(delivery.ID))
			h.releaseClaimedFeishuDelivery(ctx, delivery, "approval is missing")
			continue
		}
		approval, err := h.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{
			ID: delivery.ApprovalID, WorkspaceID: delivery.WorkspaceID,
		})
		if err != nil {
			slog.Warn("飞书自动重试加载审批失败", "delivery_id", uuidToString(delivery.ID), "error", err)
			h.releaseClaimedFeishuDelivery(ctx, delivery, err.Error())
			continue
		}
		result, err := h.retryAIApprovalExecution(ctx, aiApprovalRetryOptions{
			WorkspaceID: delivery.WorkspaceID,
			ApprovalID:  delivery.ApprovalID,
			ActorType:   "ai_me",
			ActorID:     approval.RequesterUserID,
			Note:        "automatic delivery retry",
			Automatic:   true,
		})
		if err != nil {
			slog.Warn("飞书自动重试执行失败", "delivery_id", uuidToString(delivery.ID), "approval_id", uuidToString(delivery.ApprovalID), "error", err)
			h.releaseClaimedFeishuDelivery(ctx, delivery, err.Error())
			continue
		}
		processed++
		h.publishAIApprovalRetryResult(
			ctx,
			result,
			uuidToString(delivery.WorkspaceID),
			"ai_me",
			uuidToString(approval.RequesterUserID),
		)
	}
	return processed, nil
}

// RunFeishuDeliveryRetryScheduler retries due deliveries until the context is cancelled.
func (h *Handler) RunFeishuDeliveryRetryScheduler(ctx context.Context) {
	interval := time.Duration(int32FromEnv("AI_ME_FEISHU_RETRY_POLL_SECONDS", 15)) * time.Second
	if interval < time.Second {
		interval = time.Second
	}
	batchSize := int32FromEnv("AI_ME_FEISHU_RETRY_BATCH_SIZE", 20)
	retry := func() {
		processed, err := h.RetryDueFeishuDeliveries(ctx, batchSize)
		if err != nil && ctx.Err() == nil {
			slog.Warn("飞书自动重试轮询失败", "error", err)
			return
		}
		if processed > 0 {
			slog.Info("飞书自动重试已处理", "count", processed)
		}
	}
	retry()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			retry()
		}
	}
}

func (h *Handler) releaseClaimedFeishuDelivery(ctx context.Context, delivery db.AiMeFeishuDelivery, reason string) {
	_, err := h.Queries.ReleaseClaimedFeishuDelivery(ctx, db.ReleaseClaimedFeishuDeliveryParams{
		LastError:         truncateText(reason, 800),
		RetryAfterSeconds: int32FromEnv("AI_ME_FEISHU_RETRY_AFTER_SECONDS", 300),
		ID:                delivery.ID,
	})
	if err != nil && !isNotFound(err) {
		slog.Warn("飞书自动重试释放发送记录失败", "delivery_id", uuidToString(delivery.ID), "error", err)
	}
}

func (h *Handler) recordFeishuDeliverySending(ctx context.Context, approval db.AiMeApproval, messageID string) {
	if h.Queries == nil || !approval.ID.Valid || !approval.WorkspaceID.Valid {
		return
	}
	_, err := h.Queries.UpsertFeishuDeliverySending(ctx, db.UpsertFeishuDeliverySendingParams{
		WorkspaceID:     approval.WorkspaceID,
		ApprovalID:      approval.ID,
		SourceMessageID: messageID,
	})
	if err != nil {
		slog.Warn("飞书发送状态记录失败", "approval_id", uuidToString(approval.ID), "error", err)
	}
}

func (h *Handler) recordFeishuDeliverySucceeded(ctx context.Context, approval db.AiMeApproval, replyMessageID string) {
	if h.Queries == nil || !approval.ID.Valid {
		return
	}
	_, err := h.Queries.MarkFeishuDeliverySucceeded(ctx, db.MarkFeishuDeliverySucceededParams{
		ApprovalID:     approval.ID,
		ReplyMessageID: pgtype.Text{String: strings.TrimSpace(replyMessageID), Valid: strings.TrimSpace(replyMessageID) != ""},
	})
	if err != nil {
		slog.Warn("飞书发送成功状态记录失败", "approval_id", uuidToString(approval.ID), "error", err)
	}
}

func (h *Handler) recordFeishuDeliveryFailed(ctx context.Context, approval db.AiMeApproval, sendErr error) {
	if h.Queries == nil || !approval.ID.Valid || sendErr == nil {
		return
	}
	_, err := h.Queries.MarkFeishuDeliveryFailed(ctx, db.MarkFeishuDeliveryFailedParams{
		ApprovalID:        approval.ID,
		LastError:         truncateText(sendErr.Error(), 800),
		MaxAttempts:       int32FromEnv("AI_ME_FEISHU_SEND_MAX_ATTEMPTS", 3),
		RetryAfterSeconds: int32FromEnv("AI_ME_FEISHU_RETRY_AFTER_SECONDS", 300),
	})
	if err != nil {
		slog.Warn("飞书发送失败状态记录失败", "approval_id", uuidToString(approval.ID), "error", err)
	}
}

func (h *Handler) buildAIMeOnboardingResponse(ctx context.Context, workspaceUUID pgtype.UUID, status FeishuIntegrationStatusResponse) (AIMeOnboardingResponse, error) {
	workspace, err := h.Queries.GetWorkspace(ctx, workspaceUUID)
	if err != nil {
		return AIMeOnboardingResponse{}, err
	}
	counts, err := h.Queries.GetAIMeOnboardingCounts(ctx, workspaceUUID)
	if err != nil {
		return AIMeOnboardingResponse{}, err
	}
	settings := aimeWorkspaceSettingsFromJSON(workspace.Settings)
	llmConfigured := settings.Enabled && aimeModelConfiguredForSettings(h.AIModel, settings)
	steps := []AIMeOnboardingStepResponse{
		{Key: "llm_configured", Title: "连接 AI-Me 大脑", Description: "配置 DeepSeek 或其他 LLM API，让 AI-Me 能生成判断和回复草稿。", Completed: llmConfigured},
		{Key: "workers_ready", Title: "配置 AI 员工", Description: "至少准备一个 Codex 或 Claude Code 员工用于承接任务。", Completed: counts.AgentCount > 0},
		{Key: "feishu_incoming", Title: "接收飞书消息", Description: "飞书事件入口已绑定当前工作区，可以进入例外收件箱。", Completed: status.IncomingConfigured},
		{Key: "feishu_signature", Title: "启用飞书签名", Description: "配置 FEISHU_ENCRYPT_KEY，防止伪造回调和过期重放。", Completed: status.SignatureConfigured},
		{Key: "feishu_outgoing", Title: "发送飞书回复", Description: "飞书机器人具备回复原消息的权限和 App 凭证。", Completed: status.OutgoingConfigured},
		{Key: "first_message", Title: "收到第一条真实消息", Description: "AI-Me 已经接住至少一条来自飞书的工作项。", Completed: counts.FeishuMessageCount > 0},
		{Key: "first_approval", Title: "生成第一次审批", Description: "飞书消息已进入 AI 回复审批闭环。", Completed: counts.FeishuApprovalCount > 0},
		{Key: "first_reply_sent", Title: "完成第一次发送", Description: "审批通过后，AI-Me 已成功通过飞书回复。", Completed: counts.FeishuSentCount > 0},
		{Key: "quality_reviewed", Title: "完成第一次复盘", Description: "至少为一条 AI-Me 飞书回复打分，留下质量评估。", Completed: counts.FeishuQualityReviewCount > 0},
		{Key: "budget_configured", Title: "设置每日预算", Description: "配置 AI_ME_DAILY_BUDGET_CENTS，让 AI-Me 有成本边界。", Completed: aimeDailyBudgetCentsFromEnv() > 0},
		{Key: "dogfood_20", Title: "跑满 20 条真实狗粮", Description: "用真实同事消息验证连续工作稳定性。", Completed: counts.FeishuMessageCount >= 20},
	}
	completed := 0
	for _, step := range steps {
		if step.Completed {
			completed++
		}
	}
	return AIMeOnboardingResponse{
		Completed:      completed == len(steps),
		CompletedSteps: completed,
		TotalSteps:     len(steps),
		Steps:          steps,
	}, nil
}

func aimeDraftCostCentsFromEnv() int64 {
	return int64FromEnv("AI_ME_LLM_DRAFT_COST_CENTS", 1)
}

func aimeDailyBudgetCentsFromEnv() int64 {
	return int64FromEnv("AI_ME_DAILY_BUDGET_CENTS", 200)
}

func int64FromEnv(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}

func int32FromEnv(key string, fallback int32) int32 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil || parsed < 0 {
		return fallback
	}
	return int32(parsed)
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
	security := verifyFeishuWebhookSecurity(r, body, config)

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

	if config.EncryptKey != "" && !security.SignatureVerified {
		slog.Warn("飞书事件签名校验失败", append(logAttrs, "reason", security.Reason)...)
		h.recordFeishuWebhookRejected(r.Context(), payload, config, security)
		writeError(w, http.StatusUnauthorized, "invalid feishu signature")
		return
	}

	if !secureEqual(firstNonEmpty(payload.Header.Token, payload.Token), config.WebhookToken) {
		slog.Warn("飞书事件被拒绝", append(logAttrs, "reason", "invalid_token")...)
		security.TokenVerified = false
		security.Reason = "invalid_token"
		h.recordFeishuWebhookRejected(r.Context(), payload, config, security)
		writeError(w, http.StatusUnauthorized, "invalid feishu token")
		return
	}
	security.TokenVerified = true

	eventType := firstNonEmpty(payload.Header.EventType, payload.Type)
	if eventType != "im.message.receive_v1" {
		slog.Info("飞书事件已忽略", append(logAttrs, "reason", "unsupported_event_type", "event_type", eventType)...)
		h.recordFeishuWebhookIgnored(r.Context(), payload, config, security, "unsupported_event_type")
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored", "reason": "unsupported_event_type"})
		return
	}

	record, duplicate, err := h.recordFeishuWebhookReceived(r.Context(), payload, config, security)
	if err != nil {
		slog.Warn("飞书事件可靠性记录失败", append(logAttrs, "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to record feishu webhook event")
		return
	}
	if duplicate {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "duplicate",
			"inbox_item_id": uuidToString(record.InboxItemID),
			"approval_id":   uuidToString(record.ApprovalID),
		})
		return
	}

	result, err := h.ingestFeishuMessage(r.Context(), payload, config, logAttrs)
	if err != nil {
		slog.Warn("飞书消息进入 AI-Me 收件箱失败", append(logAttrs, "error", err)...)
		h.updateFeishuWebhookEventFromResult(r.Context(), payload, config, "failed", err.Error(), result)
		writeError(w, http.StatusInternalServerError, "failed to ingest feishu message")
		return
	}
	if result.Status == "ignored" {
		h.updateFeishuWebhookEventFromResult(r.Context(), payload, config, "ignored", result.Reason, result)
		writeJSON(w, http.StatusOK, map[string]string{"status": result.Status, "reason": result.Reason})
		return
	}
	if result.Status == "duplicate" {
		h.updateFeishuWebhookEventFromResult(r.Context(), payload, config, "duplicate", "message_duplicate", result)
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        result.Status,
			"inbox_item_id": result.InboxItemID,
			"approval_id":   result.ApprovalID,
		})
		return
	}
	h.updateFeishuWebhookEventFromResult(r.Context(), payload, config, "accepted", "", result)
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

type feishuWebhookSecurityResult struct {
	SignatureVerified bool
	TokenVerified     bool
	ReplayProtected   bool
	Reason            string
	RequestTimestamp  pgtype.Timestamptz
	RawBodySHA256     string
}

func verifyFeishuWebhookSecurity(r *http.Request, body []byte, cfg feishuConfig) feishuWebhookSecurityResult {
	result := feishuWebhookSecurityResult{
		Reason:        "signature_not_configured",
		RawBodySHA256: sha256Hex(body),
	}
	if cfg.EncryptKey == "" {
		return result
	}
	signature := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Lark-Signature")))
	timestamp := strings.TrimSpace(r.Header.Get("X-Lark-Request-Timestamp"))
	nonce := strings.TrimSpace(r.Header.Get("X-Lark-Request-Nonce"))
	if signature == "" || timestamp == "" || nonce == "" {
		result.Reason = "signature_headers_missing"
		return result
	}
	parsedTimestamp, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || parsedTimestamp <= 0 {
		result.Reason = "signature_timestamp_invalid"
		return result
	}
	requestTime := time.Unix(parsedTimestamp, 0)
	result.RequestTimestamp = pgtype.Timestamptz{Time: requestTime, Valid: true}
	now := time.Now()
	if requestTime.Before(now.Add(-5*time.Minute)) || requestTime.After(now.Add(5*time.Minute)) {
		result.Reason = "signature_timestamp_out_of_range"
		return result
	}
	base := append([]byte(timestamp+nonce+cfg.EncryptKey), body...)
	sum := sha256.Sum256(base)
	expected := hex.EncodeToString(sum[:])
	if !secureEqual(expected, signature) {
		result.Reason = "signature_mismatch"
		return result
	}
	result.SignatureVerified = true
	result.ReplayProtected = true
	result.Reason = ""
	return result
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func (h *Handler) recordFeishuWebhookReceived(ctx context.Context, payload feishuEventCallback, cfg feishuConfig, security feishuWebhookSecurityResult) (db.AiMeFeishuWebhookEvent, bool, error) {
	eventKey := feishuWebhookEventKey(payload, security.RawBodySHA256)
	if eventKey == "" || h.Queries == nil {
		return db.AiMeFeishuWebhookEvent{}, false, nil
	}
	if existing, err := h.Queries.FindFeishuWebhookEventByKey(ctx, eventKey); err == nil {
		updated, updateErr := h.Queries.MarkFeishuWebhookEventDuplicate(ctx, eventKey)
		if updateErr != nil {
			return existing, true, updateErr
		}
		return updated, true, nil
	} else if !isNotFound(err) {
		return db.AiMeFeishuWebhookEvent{}, false, err
	}
	created, err := h.Queries.CreateFeishuWebhookEvent(ctx, db.CreateFeishuWebhookEventParams{
		WorkspaceID:       h.feishuWebhookWorkspaceUUID(ctx, cfg),
		EventKey:          eventKey,
		EventID:           payload.Header.EventID,
		MessageID:         payload.Event.Message.MessageID,
		EventType:         firstNonEmpty(payload.Header.EventType, payload.Type),
		Status:            "received",
		Reason:            firstNonEmpty(security.Reason, ""),
		SignatureVerified: security.SignatureVerified,
		TokenVerified:     security.TokenVerified,
		ReplayProtected:   security.ReplayProtected,
		RequestTimestamp:  security.RequestTimestamp,
		RawBodySha256:     security.RawBodySHA256,
	})
	return created, false, err
}

func (h *Handler) recordFeishuWebhookRejected(ctx context.Context, payload feishuEventCallback, cfg feishuConfig, security feishuWebhookSecurityResult) {
	h.recordFeishuWebhookTerminal(ctx, payload, cfg, security, "rejected", firstNonEmpty(security.Reason, "rejected"))
}

func (h *Handler) recordFeishuWebhookIgnored(ctx context.Context, payload feishuEventCallback, cfg feishuConfig, security feishuWebhookSecurityResult, reason string) {
	h.recordFeishuWebhookTerminal(ctx, payload, cfg, security, "ignored", reason)
}

func (h *Handler) recordFeishuWebhookTerminal(ctx context.Context, payload feishuEventCallback, cfg feishuConfig, security feishuWebhookSecurityResult, status, reason string) {
	if h.Queries == nil {
		return
	}
	event, duplicate, err := h.recordFeishuWebhookReceived(ctx, payload, cfg, security)
	if err != nil {
		slog.Warn("飞书事件终态记录失败", "event_key", feishuWebhookEventKey(payload, security.RawBodySHA256), "error", err)
		return
	}
	if duplicate {
		return
	}
	_, err = h.Queries.UpdateFeishuWebhookEventStatus(ctx, db.UpdateFeishuWebhookEventStatusParams{
		WorkspaceID: h.feishuWebhookWorkspaceUUID(ctx, cfg),
		Status:      status,
		Reason:      pgtype.Text{String: reason, Valid: reason != ""},
		EventKey:    event.EventKey,
	})
	if err != nil {
		slog.Warn("飞书事件终态更新失败", "event_key", event.EventKey, "error", err)
	}
}

func (h *Handler) updateFeishuWebhookEventFromResult(ctx context.Context, payload feishuEventCallback, cfg feishuConfig, status, reason string, result feishuIngestResult) {
	if h.Queries == nil {
		return
	}
	eventKey := feishuWebhookEventKey(payload, "")
	workspaceID := h.feishuWebhookWorkspaceUUID(ctx, cfg)
	if result.WorkspaceID != "" {
		workspaceID = feishuOptionalUUID(result.WorkspaceID)
	}
	_, err := h.Queries.UpdateFeishuWebhookEventStatus(ctx, db.UpdateFeishuWebhookEventStatusParams{
		WorkspaceID: workspaceID,
		Status:      status,
		Reason:      pgtype.Text{String: strings.TrimSpace(reason), Valid: strings.TrimSpace(reason) != ""},
		InboxItemID: feishuOptionalUUID(result.InboxItemID),
		ApprovalID:  feishuOptionalUUID(result.ApprovalID),
		EventKey:    eventKey,
	})
	if err != nil {
		slog.Warn("飞书事件状态更新失败", "event_key", eventKey, "status", status, "error", err)
	}
}

func (h *Handler) feishuWebhookWorkspaceUUID(ctx context.Context, cfg feishuConfig) pgtype.UUID {
	workspace, err := h.resolveFeishuWorkspace(ctx, cfg)
	if err != nil {
		return pgtype.UUID{}
	}
	return workspace.ID
}

func feishuWebhookEventKey(payload feishuEventCallback, fallbackHash string) string {
	return firstNonEmpty(payload.Header.EventID, payload.Event.Message.MessageID, fallbackHash)
}

func feishuOptionalUUID(value string) pgtype.UUID {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.UUID{}
	}
	parsed, err := util.ParseUUID(value)
	if err != nil {
		return pgtype.UUID{}
	}
	return parsed
}

type feishuConfig struct {
	WebhookToken       string
	EncryptKey         string
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
		EncryptKey:         strings.TrimSpace(os.Getenv("FEISHU_ENCRYPT_KEY")),
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
