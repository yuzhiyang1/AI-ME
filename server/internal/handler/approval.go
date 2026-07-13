package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

var (
	approvalSourceTypes = map[string]bool{
		"ai_me_think": true,
		"exception":   true,
		"inbox":       true,
		"issue":       true,
		"comment":     true,
		"agent_task":  true,
		"memory":      true,
		"feishu":      true,
		"email":       true,
		"github":      true,
		"manual":      true,
	}
	approvalStatuses = map[string]bool{
		"pending":    true,
		"approved":   true,
		"rejected":   true,
		"observing":  true,
		"taken_over": true,
		"expired":    true,
	}
	approvalRiskLevels = map[string]bool{
		"low":    true,
		"medium": true,
		"high":   true,
	}
	approvalReversibilities = map[string]bool{
		"reversible":           true,
		"partially_reversible": true,
		"irreversible":         true,
	}
	approvalActionTypes = map[string]bool{
		"create_issue":          true,
		"assign_worker":         true,
		"draft_reply":           true,
		"send_external_message": true,
		"post_internal_comment": true,
		"confirm_memory":        true,
		"no_action":             true,
	}
	approvalEvidenceTypes = map[string]bool{
		"user_input": true,
		"issue":      true,
		"comment":    true,
		"activity":   true,
		"agent_task": true,
		"memory":     true,
		"document":   true,
		"feishu":     true,
		"email":      true,
		"github":     true,
		"ci":         true,
		"log":        true,
	}
)

type AIApprovalResponse struct {
	ID                 string                       `json:"id"`
	WorkspaceID        string                       `json:"workspace_id"`
	RequesterUserID    *string                      `json:"requester_user_id"`
	SourceType         string                       `json:"source_type"`
	SourceRefID        *string                      `json:"source_ref_id"`
	SourceURL          *string                      `json:"source_url"`
	IssueID            *string                      `json:"issue_id"`
	InboxItemID        *string                      `json:"inbox_item_id"`
	TaskQueueID        *string                      `json:"task_queue_id"`
	MemoryID           *string                      `json:"memory_id"`
	ToolCallID         *string                      `json:"tool_call_id"`
	Title              string                       `json:"title"`
	Summary            string                       `json:"summary"`
	Status             string                       `json:"status"`
	RiskLevel          string                       `json:"risk_level"`
	Confidence         float64                      `json:"confidence"`
	Reversibility      string                       `json:"reversibility"`
	ActionType         string                       `json:"action_type"`
	ActionTitle        string                       `json:"action_title"`
	ActionDescription  string                       `json:"action_description"`
	OriginalPayload    json.RawMessage              `json:"original_payload"`
	FinalPayload       json.RawMessage              `json:"final_payload"`
	AIReasoningSummary string                       `json:"ai_reasoning_summary"`
	ApprovalNote       string                       `json:"approval_note"`
	RejectionReason    string                       `json:"rejection_reason"`
	ApprovedBy         *string                      `json:"approved_by"`
	ApprovedAt         *string                      `json:"approved_at"`
	RejectedBy         *string                      `json:"rejected_by"`
	RejectedAt         *string                      `json:"rejected_at"`
	ObservedBy         *string                      `json:"observed_by"`
	ObservedAt         *string                      `json:"observed_at"`
	TakenOverBy        *string                      `json:"taken_over_by"`
	TakenOverAt        *string                      `json:"taken_over_at"`
	ExecutedAt         *string                      `json:"executed_at"`
	ExecutionStatus    string                       `json:"execution_status"`
	ExecutionError     string                       `json:"execution_error"`
	CreatedIssueID     *string                      `json:"created_issue_id"`
	CreatedTaskID      *string                      `json:"created_task_id"`
	CreatedCommentID   *string                      `json:"created_comment_id"`
	ExpiresAt          *string                      `json:"expires_at"`
	CreatedAt          string                       `json:"created_at"`
	UpdatedAt          string                       `json:"updated_at"`
	Evidence           []AIApprovalEvidenceResponse `json:"evidence,omitempty"`
	Events             []AIApprovalEventResponse    `json:"events,omitempty"`
}

type AIApprovalEvidenceResponse struct {
	ID           string          `json:"id"`
	ApprovalID   string          `json:"approval_id"`
	WorkspaceID  string          `json:"workspace_id"`
	EvidenceType string          `json:"evidence_type"`
	Label        string          `json:"label"`
	RefID        *string         `json:"ref_id"`
	SourceURL    *string         `json:"source_url"`
	Quote        string          `json:"quote"`
	Metadata     json.RawMessage `json:"metadata"`
	CreatedAt    string          `json:"created_at"`
}

type AIApprovalEventResponse struct {
	ID          string          `json:"id"`
	ApprovalID  string          `json:"approval_id"`
	WorkspaceID string          `json:"workspace_id"`
	ActorType   string          `json:"actor_type"`
	ActorID     *string         `json:"actor_id"`
	EventType   string          `json:"event_type"`
	FromStatus  *string         `json:"from_status"`
	ToStatus    *string         `json:"to_status"`
	Payload     json.RawMessage `json:"payload"`
	CreatedAt   string          `json:"created_at"`
}

type AIApprovalStatsResponse struct {
	Total           int64 `json:"total"`
	Pending         int64 `json:"pending"`
	HighRiskPending int64 `json:"high_risk_pending"`
	Observing       int64 `json:"observing"`
	Approved        int64 `json:"approved"`
	Rejected        int64 `json:"rejected"`
	TakenOver       int64 `json:"taken_over"`
	Expired         int64 `json:"expired"`
	Succeeded       int64 `json:"succeeded"`
	Failed          int64 `json:"failed"`
}

type CreateAIApprovalEvidenceRequest struct {
	EvidenceType string `json:"evidence_type"`
	Label        string `json:"label"`
	RefID        string `json:"ref_id"`
	SourceURL    string `json:"source_url"`
	Quote        string `json:"quote"`
	Metadata     any    `json:"metadata"`
}

type CreateAIApprovalRequest struct {
	SourceType         string                            `json:"source_type"`
	SourceRefID        string                            `json:"source_ref_id"`
	SourceURL          string                            `json:"source_url"`
	IssueID            string                            `json:"issue_id"`
	InboxItemID        string                            `json:"inbox_item_id"`
	TaskQueueID        string                            `json:"task_queue_id"`
	MemoryID           string                            `json:"memory_id"`
	Title              string                            `json:"title"`
	Summary            string                            `json:"summary"`
	RiskLevel          string                            `json:"risk_level"`
	Confidence         *float64                          `json:"confidence"`
	Reversibility      string                            `json:"reversibility"`
	ActionType         string                            `json:"action_type"`
	ActionTitle        string                            `json:"action_title"`
	ActionDescription  string                            `json:"action_description"`
	OriginalPayload    any                               `json:"original_payload"`
	FinalPayload       any                               `json:"final_payload"`
	AIReasoningSummary string                            `json:"ai_reasoning_summary"`
	ExpiresAt          string                            `json:"expires_at"`
	Evidence           []CreateAIApprovalEvidenceRequest `json:"evidence"`
}

type UpdateAIApprovalRequest struct {
	Title             *string          `json:"title"`
	Summary           *string          `json:"summary"`
	RiskLevel         *string          `json:"risk_level"`
	Confidence        *float64         `json:"confidence"`
	Reversibility     *string          `json:"reversibility"`
	ActionTitle       *string          `json:"action_title"`
	ActionDescription *string          `json:"action_description"`
	FinalPayload      *json.RawMessage `json:"final_payload"`
	ApprovalNote      *string          `json:"approval_note"`
	ExpiresAt         *string          `json:"expires_at"`
}

type AIApprovalTransitionRequest struct {
	Note         string           `json:"note"`
	Reason       string           `json:"reason"`
	FinalPayload *json.RawMessage `json:"final_payload"`
}

type AIApprovalQualityRequest struct {
	Score   int    `json:"score"`
	Note    string `json:"note"`
	Outcome string `json:"outcome"`
}

func aiApprovalToResponse(a db.AiMeApproval) AIApprovalResponse {
	return AIApprovalResponse{
		ID:                 uuidToString(a.ID),
		WorkspaceID:        uuidToString(a.WorkspaceID),
		RequesterUserID:    uuidToPtr(a.RequesterUserID),
		SourceType:         a.SourceType,
		SourceRefID:        textToPtr(a.SourceRefID),
		SourceURL:          textToPtr(a.SourceUrl),
		IssueID:            uuidToPtr(a.IssueID),
		InboxItemID:        uuidToPtr(a.InboxItemID),
		TaskQueueID:        uuidToPtr(a.TaskQueueID),
		MemoryID:           uuidToPtr(a.MemoryID),
		ToolCallID:         uuidToPtr(a.ToolCallID),
		Title:              a.Title,
		Summary:            a.Summary,
		Status:             a.Status,
		RiskLevel:          a.RiskLevel,
		Confidence:         numericToFloat64(a.Confidence),
		Reversibility:      a.Reversibility,
		ActionType:         a.ActionType,
		ActionTitle:        a.ActionTitle,
		ActionDescription:  a.ActionDescription,
		OriginalPayload:    rawJSONOrObject(a.OriginalPayload),
		FinalPayload:       rawJSONOrObject(a.FinalPayload),
		AIReasoningSummary: a.AiReasoningSummary,
		ApprovalNote:       a.ApprovalNote,
		RejectionReason:    a.RejectionReason,
		ApprovedBy:         uuidToPtr(a.ApprovedBy),
		ApprovedAt:         timestampToPtr(a.ApprovedAt),
		RejectedBy:         uuidToPtr(a.RejectedBy),
		RejectedAt:         timestampToPtr(a.RejectedAt),
		ObservedBy:         uuidToPtr(a.ObservedBy),
		ObservedAt:         timestampToPtr(a.ObservedAt),
		TakenOverBy:        uuidToPtr(a.TakenOverBy),
		TakenOverAt:        timestampToPtr(a.TakenOverAt),
		ExecutedAt:         timestampToPtr(a.ExecutedAt),
		ExecutionStatus:    a.ExecutionStatus,
		ExecutionError:     a.ExecutionError,
		CreatedIssueID:     uuidToPtr(a.CreatedIssueID),
		CreatedTaskID:      uuidToPtr(a.CreatedTaskID),
		CreatedCommentID:   uuidToPtr(a.CreatedCommentID),
		ExpiresAt:          timestampToPtr(a.ExpiresAt),
		CreatedAt:          timestampToString(a.CreatedAt),
		UpdatedAt:          timestampToString(a.UpdatedAt),
	}
}

func aiApprovalEvidenceToResponse(e db.AiMeApprovalEvidence) AIApprovalEvidenceResponse {
	return AIApprovalEvidenceResponse{
		ID:           uuidToString(e.ID),
		ApprovalID:   uuidToString(e.ApprovalID),
		WorkspaceID:  uuidToString(e.WorkspaceID),
		EvidenceType: e.EvidenceType,
		Label:        e.Label,
		RefID:        textToPtr(e.RefID),
		SourceURL:    textToPtr(e.SourceUrl),
		Quote:        e.Quote,
		Metadata:     rawJSONOrObject(e.Metadata),
		CreatedAt:    timestampToString(e.CreatedAt),
	}
}

func aiApprovalEventToResponse(e db.AiMeApprovalEvent) AIApprovalEventResponse {
	return AIApprovalEventResponse{
		ID:          uuidToString(e.ID),
		ApprovalID:  uuidToString(e.ApprovalID),
		WorkspaceID: uuidToString(e.WorkspaceID),
		ActorType:   e.ActorType,
		ActorID:     uuidToPtr(e.ActorID),
		EventType:   e.EventType,
		FromStatus:  textToPtr(e.FromStatus),
		ToStatus:    textToPtr(e.ToStatus),
		Payload:     rawJSONOrObject(e.Payload),
		CreatedAt:   timestampToString(e.CreatedAt),
	}
}

func (h *Handler) ListAIApprovals(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	params, ok := aiApprovalListParams(w, r, workspaceID)
	if !ok {
		return
	}
	countParams := db.CountAIApprovalsParams{
		WorkspaceID: params.WorkspaceID,
		Status:      params.Status,
		RiskLevel:   params.RiskLevel,
		ActionType:  params.ActionType,
		SourceType:  params.SourceType,
		IssueID:     params.IssueID,
	}
	approvals, err := h.Queries.ListAIApprovals(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list approvals")
		return
	}
	total, err := h.Queries.CountAIApprovals(r.Context(), countParams)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count approvals")
		return
	}
	resp := make([]AIApprovalResponse, len(approvals))
	for i, approval := range approvals {
		resp[i] = aiApprovalToResponse(approval)
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": resp, "total": total})
}

func (h *Handler) GetAIApprovalStats(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}
	stats, err := h.Queries.GetAIApprovalStats(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get approval stats")
		return
	}
	writeJSON(w, http.StatusOK, AIApprovalStatsResponse{
		Total:           stats.Total,
		Pending:         stats.Pending,
		HighRiskPending: stats.HighRiskPending,
		Observing:       stats.Observing,
		Approved:        stats.Approved,
		Rejected:        stats.Rejected,
		TakenOver:       stats.TakenOver,
		Expired:         stats.Expired,
		Succeeded:       stats.Succeeded,
		Failed:          stats.Failed,
	})
}

func aiApprovalListParams(w http.ResponseWriter, r *http.Request, workspaceID string) (db.ListAIApprovalsParams, bool) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return db.ListAIApprovalsParams{}, false
	}
	limit, offset := listPagination(r)
	status := optionalTextFromString(r.URL.Query().Get("status"))
	if status.Valid && !validateEnum(w, status.String, "status", approvalStatuses) {
		return db.ListAIApprovalsParams{}, false
	}
	riskLevel := optionalTextFromString(r.URL.Query().Get("risk_level"))
	if riskLevel.Valid && !validateEnum(w, riskLevel.String, "risk_level", approvalRiskLevels) {
		return db.ListAIApprovalsParams{}, false
	}
	actionType := optionalTextFromString(r.URL.Query().Get("action_type"))
	if actionType.Valid && !validateEnum(w, actionType.String, "action_type", approvalActionTypes) {
		return db.ListAIApprovalsParams{}, false
	}
	sourceType := optionalTextFromString(r.URL.Query().Get("source_type"))
	if sourceType.Valid && !validateEnum(w, sourceType.String, "source_type", approvalSourceTypes) {
		return db.ListAIApprovalsParams{}, false
	}
	issueID, ok := optionalUUIDFromString(w, r.URL.Query().Get("issue_id"), "issue_id")
	if !ok {
		return db.ListAIApprovalsParams{}, false
	}
	return db.ListAIApprovalsParams{
		WorkspaceID: workspaceUUID,
		Status:      status,
		RiskLevel:   riskLevel,
		ActionType:  actionType,
		SourceType:  sourceType,
		IssueID:     issueID,
		Limit:       limit,
		Offset:      offset,
	}, true
}

func (h *Handler) GetAIApproval(w http.ResponseWriter, r *http.Request) {
	approval, ok := h.loadAIApproval(w, r)
	if !ok {
		return
	}
	resp, ok := h.aiApprovalDetailResponse(w, r, approval)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) CreateAIApproval(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateAIApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	params, ok := h.createAIApprovalParams(w, req, workspaceUUID, parseUUID(userID))
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	approval, err := qtx.CreateAIApproval(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create approval")
		return
	}
	for _, evidenceReq := range req.Evidence {
		if err := createAIApprovalEvidence(r.Context(), qtx, workspaceUUID, approval.ID, evidenceReq); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if _, err := createAIApprovalEvent(r.Context(), qtx, approval, "member", parseUUID(userID), "created", "", approval.Status, nil); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create approval event")
		return
	}
	if _, _, err := recordAIApprovalActivity(r.Context(), qtx, approval, parseUUID(userID), "ai_me_approval_created", nil); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record approval activity")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	resp := aiApprovalToResponse(approval)
	h.publish(protocol.EventApprovalCreated, workspaceID, "member", userID, map[string]any{"approval": resp})
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) createAIMeApproval(ctx context.Context, workspaceID, userID string, params db.CreateAIApprovalParams, evidence []CreateAIApprovalEvidenceRequest) (db.AiMeApproval, error) {
	// Keep AI-Me generated approvals on the same audit path as manual approvals.
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.AiMeApproval{}, err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	approval, err := qtx.CreateAIApproval(ctx, params)
	if err != nil {
		return db.AiMeApproval{}, err
	}
	if approval.ToolCallID.Valid {
		if _, err := qtx.WaitAIMeToolCallForApproval(ctx, db.WaitAIMeToolCallForApprovalParams{
			ID: approval.ToolCallID, WorkspaceID: approval.WorkspaceID,
		}); err != nil {
			return db.AiMeApproval{}, err
		}
		if _, err := qtx.WaitAIMeRunForToolApproval(ctx, db.WaitAIMeRunForToolApprovalParams{
			ToolCallID: approval.ToolCallID, WorkspaceID: approval.WorkspaceID,
		}); err != nil {
			return db.AiMeApproval{}, err
		}
	}
	for _, evidenceReq := range evidence {
		if err := createAIApprovalEvidence(ctx, qtx, params.WorkspaceID, approval.ID, evidenceReq); err != nil {
			return db.AiMeApproval{}, err
		}
	}
	eventPayload := map[string]any{
		"source":        "ai_me_think",
		"source_ref_id": textToPtr(params.SourceRefID),
	}
	if _, err := createAIApprovalEvent(ctx, qtx, approval, "member", params.RequesterUserID, "created", "", approval.Status, eventPayload); err != nil {
		return db.AiMeApproval{}, err
	}
	if _, _, err := recordAIApprovalActivity(ctx, qtx, approval, params.RequesterUserID, "ai_me_approval_created", eventPayload); err != nil {
		return db.AiMeApproval{}, err
	}
	var inboxItem *db.InboxItem
	if item, ok, err := createAIApprovalInboxItem(ctx, qtx, approval); err != nil {
		return db.AiMeApproval{}, err
	} else if ok {
		inboxItem = &item
		approval, err = qtx.LinkAIApprovalInboxItem(ctx, db.LinkAIApprovalInboxItemParams{
			InboxItemID: item.ID,
			ID:          approval.ID,
			WorkspaceID: approval.WorkspaceID,
		})
		if err != nil {
			return db.AiMeApproval{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return db.AiMeApproval{}, err
	}
	resp := aiApprovalToResponse(approval)
	h.publish(protocol.EventApprovalCreated, workspaceID, "member", userID, map[string]any{"approval": resp})
	if inboxItem != nil {
		h.publish(protocol.EventInboxNew, workspaceID, "member", userID, map[string]any{"item": inboxToResponse(*inboxItem)})
	}
	return approval, nil
}

func createAIApprovalInboxItem(ctx context.Context, q *db.Queries, approval db.AiMeApproval) (db.InboxItem, bool, error) {
	if approval.Status != "pending" || approval.ActionType != "send_external_message" || !approval.RequesterUserID.Valid {
		return db.InboxItem{}, false, nil
	}
	title := strings.TrimSpace(approval.ActionTitle)
	if title == "" {
		title = strings.TrimSpace(approval.Title)
	}
	if title == "" {
		title = "AI-Me 外部回复待审批"
	}
	body := strings.TrimSpace(approval.ActionDescription)
	if body == "" {
		body = strings.TrimSpace(approval.Summary)
	}
	item, err := q.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   approval.WorkspaceID,
		RecipientType: "member",
		RecipientID:   approval.RequesterUserID,
		Type:          "review_requested",
		Severity:      "action_required",
		IssueID:       approval.IssueID,
		Title:         title,
		Body:          optionalTextFromString(body),
		Details:       aiApprovalInboxDetails(approval),
	})
	if err != nil {
		return db.InboxItem{}, false, err
	}
	return item, true, nil
}

func aiApprovalInboxDetails(approval db.AiMeApproval) []byte {
	payload := approvalEffectivePayload(approval, nil)
	details := map[string]any{
		"approval_id": uuidToString(approval.ID),
		"action_type": approval.ActionType,
		"source_type": approval.SourceType,
	}
	if sourceRefID := pgTextValue(approval.SourceRefID); sourceRefID != "" {
		details["source_ref_id"] = sourceRefID
	}
	if channel := approvalPayloadText(payload, "channel"); channel != "" {
		details["channel"] = channel
	}
	if messageID := approvalPayloadText(payload, "message_id", "feishu_message_id", "source_message_id"); messageID != "" {
		details["message_id"] = messageID
	}
	if chatID := approvalPayloadText(payload, "chat_id"); chatID != "" {
		details["chat_id"] = chatID
	}
	if replyPreview := approvalPayloadText(payload, "text", "content", "reply_text", "reply_draft", "draft", "body"); replyPreview != "" {
		details["reply_preview"] = truncateText(replyPreview, 240)
	}
	return jsonBytesOrObject(details)
}

func (h *Handler) createAIApprovalParams(w http.ResponseWriter, req CreateAIApprovalRequest, workspaceID, userID pgtype.UUID) (db.CreateAIApprovalParams, bool) {
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return db.CreateAIApprovalParams{}, false
	}
	sourceType := normalizeOptionalEnum(req.SourceType, "manual")
	if !validateEnum(w, sourceType, "source_type", approvalSourceTypes) {
		return db.CreateAIApprovalParams{}, false
	}
	riskLevel := normalizeOptionalEnum(req.RiskLevel, "medium")
	if !validateEnum(w, riskLevel, "risk_level", approvalRiskLevels) {
		return db.CreateAIApprovalParams{}, false
	}
	reversibility := normalizeOptionalEnum(req.Reversibility, "partially_reversible")
	if !validateEnum(w, reversibility, "reversibility", approvalReversibilities) {
		return db.CreateAIApprovalParams{}, false
	}
	actionType := strings.TrimSpace(req.ActionType)
	if !validateEnum(w, actionType, "action_type", approvalActionTypes) {
		return db.CreateAIApprovalParams{}, false
	}
	confidence := 0.5
	if req.Confidence != nil {
		confidence = *req.Confidence
	}
	confidenceNumeric, err := numericFromFloat64(confidence)
	if err != nil {
		writeError(w, http.StatusBadRequest, "confidence must be between 0 and 1")
		return db.CreateAIApprovalParams{}, false
	}
	issueID, ok := optionalUUIDFromString(w, req.IssueID, "issue_id")
	if !ok {
		return db.CreateAIApprovalParams{}, false
	}
	inboxItemID, ok := optionalUUIDFromString(w, req.InboxItemID, "inbox_item_id")
	if !ok {
		return db.CreateAIApprovalParams{}, false
	}
	taskQueueID, ok := optionalUUIDFromString(w, req.TaskQueueID, "task_queue_id")
	if !ok {
		return db.CreateAIApprovalParams{}, false
	}
	memoryID, ok := optionalUUIDFromString(w, req.MemoryID, "memory_id")
	if !ok {
		return db.CreateAIApprovalParams{}, false
	}
	expiresAt, ok := optionalTimestampFromString(w, req.ExpiresAt, "expires_at")
	if !ok {
		return db.CreateAIApprovalParams{}, false
	}
	originalPayload := jsonBytesOrObject(req.OriginalPayload)
	finalPayload := jsonBytesOrObject(req.FinalPayload)
	if req.FinalPayload == nil {
		finalPayload = originalPayload
	}
	actionTitle := strings.TrimSpace(req.ActionTitle)
	if actionTitle == "" {
		actionTitle = req.Title
	}
	return db.CreateAIApprovalParams{
		WorkspaceID:        workspaceID,
		RequesterUserID:    userID,
		SourceType:         sourceType,
		SourceRefID:        optionalTextFromString(req.SourceRefID),
		SourceUrl:          optionalTextFromString(req.SourceURL),
		IssueID:            issueID,
		InboxItemID:        inboxItemID,
		TaskQueueID:        taskQueueID,
		MemoryID:           memoryID,
		Title:              req.Title,
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
		ExpiresAt:          expiresAt,
	}, true
}

func (h *Handler) UpdateAIApproval(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	approvalID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "approval id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req UpdateAIApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	params := db.UpdateAIApprovalParams{ID: approvalID, WorkspaceID: workspaceUUID}
	if req.Title != nil {
		value := strings.TrimSpace(*req.Title)
		if value == "" {
			writeError(w, http.StatusBadRequest, "title cannot be empty")
			return
		}
		params.Title = pgtype.Text{String: value, Valid: true}
	}
	params.Summary = optionalTextFromPtr(req.Summary)
	if req.RiskLevel != nil {
		value := strings.TrimSpace(*req.RiskLevel)
		if !validateEnum(w, value, "risk_level", approvalRiskLevels) {
			return
		}
		params.RiskLevel = pgtype.Text{String: value, Valid: true}
	}
	if req.Confidence != nil {
		n, err := optionalNumericFromFloat64(req.Confidence)
		if err != nil {
			writeError(w, http.StatusBadRequest, "confidence must be between 0 and 1")
			return
		}
		params.Confidence = n
	}
	if req.Reversibility != nil {
		value := strings.TrimSpace(*req.Reversibility)
		if !validateEnum(w, value, "reversibility", approvalReversibilities) {
			return
		}
		params.Reversibility = pgtype.Text{String: value, Valid: true}
	}
	params.ActionTitle = optionalTextFromPtr(req.ActionTitle)
	params.ActionDescription = optionalTextFromPtr(req.ActionDescription)
	params.ApprovalNote = optionalTextFromPtr(req.ApprovalNote)
	if req.FinalPayload != nil {
		raw, ok := rawJSONFromRequest(w, req.FinalPayload, "final_payload")
		if !ok {
			return
		}
		params.FinalPayload = raw
	}
	if req.ExpiresAt != nil {
		params.ExpiresAt, ok = optionalTimestampFromPtr(w, req.ExpiresAt, "expires_at")
		if !ok {
			return
		}
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	updated, err := qtx.UpdateAIApproval(r.Context(), params)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusConflict, "approval cannot be edited in its current status")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update approval")
		return
	}
	if _, err := qtx.CreateAIApprovalEvent(r.Context(), db.CreateAIApprovalEventParams{
		ApprovalID:  updated.ID,
		WorkspaceID: updated.WorkspaceID,
		ActorType:   "member",
		ActorID:     parseUUID(userID),
		EventType:   "edited",
		FromStatus:  pgtype.Text{String: updated.Status, Valid: true},
		ToStatus:    pgtype.Text{String: updated.Status, Valid: true},
		Payload:     jsonBytesOrObject(map[string]any{"approval_id": uuidToString(updated.ID)}),
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create approval event")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	resp := aiApprovalToResponse(updated)
	h.publish(protocol.EventApprovalUpdated, workspaceID, "member", userID, map[string]any{"approval": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) ApproveAIApproval(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	approvalID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "approval id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req AIApprovalTransitionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	finalPayload, ok := rawJSONFromRequest(w, req.FinalPayload, "final_payload")
	if !ok {
		return
	}
	userUUID := parseUUID(userID)
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	existing, err := qtx.GetAIApprovalInWorkspace(r.Context(), db.GetAIApprovalInWorkspaceParams{
		ID: approvalID, WorkspaceID: workspaceUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "approval not found")
		return
	}
	if existing.Status != "pending" && existing.Status != "observing" {
		writeError(w, http.StatusConflict, "approval cannot be approved in its current status")
		return
	}
	effectivePayload := approvalEffectivePayload(existing, finalPayload)
	execution := h.executeApprovedAIActionInSavepoint(r.Context(), tx, existing, workspaceUUID, userUUID, effectivePayload)
	updated, err := qtx.ApproveAIApproval(r.Context(), db.ApproveAIApprovalParams{
		ApprovedBy:       userUUID,
		ApprovalNote:     optionalTextFromString(req.Note),
		FinalPayload:     finalPayload,
		ExecutionStatus:  execution.Status,
		ExecutionError:   optionalTextFromString(execution.ExecutionError),
		CreatedIssueID:   execution.CreatedIssueID,
		CreatedTaskID:    execution.CreatedTaskID,
		CreatedCommentID: execution.CreatedCommentID,
		ID:               approvalID,
		WorkspaceID:      workspaceUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to approve approval")
		return
	}
	if err := finishAIMeToolCallAfterApproval(r.Context(), qtx, existing, execution); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to finish AI-Me tool call")
		return
	}
	if _, err := createAIApprovalEvent(r.Context(), qtx, updated, "member", userUUID, "approved", existing.Status, updated.Status, map[string]any{"note": req.Note}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create approval event")
		return
	}
	executionEventType := "execution_succeeded"
	if execution.Status == "failed" {
		executionEventType = "execution_failed"
	}
	if execution.Status == "succeeded" || execution.Status == "failed" {
		payload := approvalExecutionEventPayload(updated, execution)
		if _, err := createAIApprovalEvent(r.Context(), qtx, updated, "member", userUUID, executionEventType, updated.Status, updated.Status, payload); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create execution event")
			return
		}
		if err := createAIApprovalEvidence(r.Context(), qtx, updated.WorkspaceID, updated.ID, approvalExecutionEvidenceRequest(updated, execution, payload)); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create execution evidence")
			return
		}
	}
	approvalActivity, hasApprovalActivity, err := recordAIApprovalActivity(r.Context(), qtx, updated, userUUID, "ai_me_approval_approved", approvalExecutionEventPayload(updated, execution))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record approval activity")
		return
	}
	archivedInboxItems, err := archiveAIApprovalInboxItems(r.Context(), qtx, updated)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to archive approval inbox item")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	resp := aiApprovalToResponse(updated)
	if execution.CreatedIssue != nil {
		h.publishApprovalIssueCreated(r.Context(), *execution.CreatedIssue, workspaceID, userID)
	}
	if execution.UpdatedIssue != nil {
		h.publishApprovalIssueUpdated(r.Context(), *execution.UpdatedIssue, execution.PreviousIssue, workspaceID, userID)
	}
	if h.TaskService != nil && len(execution.CancelledTasks) > 0 {
		h.TaskService.BroadcastCancelledTasks(r.Context(), execution.CancelledTasks)
	}
	if execution.QueuedTask != nil {
		h.publishApprovalTaskQueued(r.Context(), *execution.QueuedTask, workspaceID)
	}
	if execution.CreatedComment != nil && execution.CommentIssue != nil {
		h.publishApprovalCommentCreated(*execution.CreatedComment, *execution.CommentIssue, workspaceID, userID)
	}
	for _, activity := range execution.Activities {
		h.publishApprovalActivityCreated(activity, workspaceID, userID)
	}
	if hasApprovalActivity {
		h.publishApprovalActivityCreated(approvalActivity, workspaceID, userID)
	}
	h.publish(protocol.EventApprovalApproved, workspaceID, "member", userID, map[string]any{"approval": resp})
	if execution.Status == "succeeded" {
		h.publish(protocol.EventApprovalExecutionSucceeded, workspaceID, "member", userID, map[string]any{"approval": resp})
	}
	if execution.Status == "failed" {
		h.publish(protocol.EventApprovalExecutionFailed, workspaceID, "member", userID, map[string]any{"approval": resp})
	}
	h.publishArchivedAIApprovalInboxItems(workspaceID, userID, archivedInboxItems)
	writeJSON(w, http.StatusOK, resp)
}

func finishAIMeToolCallAfterApproval(ctx context.Context, q *db.Queries, approval db.AiMeApproval, execution approvedAIActionExecution) error {
	if !approval.ToolCallID.Valid {
		return nil
	}
	outcome := execution.Status
	if outcome != "succeeded" && outcome != "rejected" && outcome != "cancelled" {
		outcome = "failed"
	}
	result := jsonBytesOrObject(map[string]any{
		"status":             execution.Status,
		"execution_error":    execution.ExecutionError,
		"created_issue_id":   uuidToPtr(execution.CreatedIssueID),
		"created_task_id":    uuidToPtr(execution.CreatedTaskID),
		"created_comment_id": uuidToPtr(execution.CreatedCommentID),
	})
	_, err := q.FinishAIMeToolCallAfterApproval(ctx, db.FinishAIMeToolCallAfterApprovalParams{
		Outcome:          outcome,
		Result:           result,
		Error:            execution.ExecutionError,
		CreatedIssueID:   execution.CreatedIssueID,
		CreatedTaskID:    execution.CreatedTaskID,
		CreatedCommentID: execution.CreatedCommentID,
		ToolCallID:       approval.ToolCallID,
		WorkspaceID:      approval.WorkspaceID,
	})
	return err
}

func (h *Handler) RejectAIApproval(w http.ResponseWriter, r *http.Request) {
	h.transitionAIApproval(w, r, "reject")
}

func (h *Handler) RetryAIApprovalExecution(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	approvalID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "approval id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	userUUID := parseUUID(userID)
	result, err := h.retryAIApprovalExecution(r.Context(), aiApprovalRetryOptions{
		WorkspaceID: workspaceUUID,
		ApprovalID:  approvalID,
		ActorType:   "member",
		ActorID:     userUUID,
		Note:        "manual retry",
	})
	if errors.Is(err, errAIApprovalRetryNotAllowed) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "approval not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to retry approval execution")
		return
	}
	h.publishAIApprovalRetryResult(r.Context(), result, workspaceID, "member", userID)
	writeJSON(w, http.StatusOK, aiApprovalToResponse(result.Approval))
}

var errAIApprovalRetryNotAllowed = errors.New("only failed approved executions can be retried")

type aiApprovalRetryOptions struct {
	WorkspaceID pgtype.UUID
	ApprovalID  pgtype.UUID
	ActorType   string
	ActorID     pgtype.UUID
	Note        string
	Automatic   bool
}

type aiApprovalRetryResult struct {
	Approval            db.AiMeApproval
	Execution           approvedAIActionExecution
	ApprovalActivity    db.ActivityLog
	HasApprovalActivity bool
}

func (h *Handler) retryAIApprovalExecution(ctx context.Context, opts aiApprovalRetryOptions) (aiApprovalRetryResult, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("start retry transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	existing, err := qtx.ClaimAIApprovalExecutionRetry(ctx, db.ClaimAIApprovalExecutionRetryParams{
		ID: opts.ApprovalID, WorkspaceID: opts.WorkspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		if _, loadErr := qtx.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{
			ID: opts.ApprovalID, WorkspaceID: opts.WorkspaceID,
		}); loadErr != nil {
			return aiApprovalRetryResult{}, loadErr
		}
		return aiApprovalRetryResult{}, errAIApprovalRetryNotAllowed
	}
	if err != nil {
		return aiApprovalRetryResult{}, err
	}
	startPayload := map[string]any{
		"retry": true,
		"note":  opts.Note,
	}
	if opts.Automatic {
		startPayload["automatic"] = true
	}
	if _, err := createAIApprovalEvent(ctx, qtx, existing, opts.ActorType, opts.ActorID, "execution_started", existing.Status, existing.Status, startPayload); err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("create retry event: %w", err)
	}
	execution := h.executeApprovedAIActionInSavepoint(ctx, tx, existing, opts.WorkspaceID, opts.ActorID, approvalEffectivePayload(existing, nil))
	var updated db.AiMeApproval
	if execution.Status == "succeeded" {
		updated, err = qtx.MarkAIApprovalExecutionSucceeded(ctx, db.MarkAIApprovalExecutionSucceededParams{
			CreatedIssueID:   execution.CreatedIssueID,
			CreatedTaskID:    execution.CreatedTaskID,
			CreatedCommentID: execution.CreatedCommentID,
			ID:               opts.ApprovalID,
			WorkspaceID:      opts.WorkspaceID,
		})
	} else {
		if execution.Status == "" {
			execution.Status = "failed"
		}
		updated, err = qtx.MarkAIApprovalExecutionFailed(ctx, db.MarkAIApprovalExecutionFailedParams{
			ExecutionError: execution.ExecutionError,
			ID:             opts.ApprovalID,
			WorkspaceID:    opts.WorkspaceID,
		})
	}
	if err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("update retry result: %w", err)
	}
	if err := finishAIMeToolCallAfterApproval(ctx, qtx, existing, execution); err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("finish retried AI-Me tool call: %w", err)
	}
	executionEventType := "execution_succeeded"
	if execution.Status == "failed" {
		executionEventType = "execution_failed"
	}
	payload := approvalExecutionEventPayload(updated, execution)
	payload["retry"] = true
	payload["note"] = opts.Note
	if opts.Automatic {
		payload["automatic"] = true
	}
	if _, err := createAIApprovalEvent(ctx, qtx, updated, opts.ActorType, opts.ActorID, executionEventType, updated.Status, updated.Status, payload); err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("create retry result event: %w", err)
	}
	if err := createAIApprovalEvidence(ctx, qtx, updated.WorkspaceID, updated.ID, approvalExecutionEvidenceRequest(updated, execution, payload)); err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("create retry evidence: %w", err)
	}
	activityAction := "ai_me_approval_execution_retried"
	if opts.Automatic {
		activityAction = "ai_me_approval_execution_auto_retried"
	}
	approvalActivity, hasApprovalActivity, err := recordAIApprovalActivity(ctx, qtx, updated, opts.ActorID, activityAction, payload)
	if err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("record retry activity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return aiApprovalRetryResult{}, fmt.Errorf("commit retry: %w", err)
	}
	return aiApprovalRetryResult{
		Approval:            updated,
		Execution:           execution,
		ApprovalActivity:    approvalActivity,
		HasApprovalActivity: hasApprovalActivity,
	}, nil
}

func (h *Handler) publishAIApprovalRetryResult(ctx context.Context, result aiApprovalRetryResult, workspaceID, actorType, actorID string) {
	execution := result.Execution
	resp := aiApprovalToResponse(result.Approval)
	if execution.CreatedIssue != nil {
		h.publishApprovalIssueCreated(ctx, *execution.CreatedIssue, workspaceID, actorID)
	}
	if execution.UpdatedIssue != nil {
		h.publishApprovalIssueUpdated(ctx, *execution.UpdatedIssue, execution.PreviousIssue, workspaceID, actorID)
	}
	if h.TaskService != nil && len(execution.CancelledTasks) > 0 {
		h.TaskService.BroadcastCancelledTasks(ctx, execution.CancelledTasks)
	}
	if execution.QueuedTask != nil {
		h.publishApprovalTaskQueued(ctx, *execution.QueuedTask, workspaceID)
	}
	if execution.CreatedComment != nil && execution.CommentIssue != nil {
		h.publishApprovalCommentCreated(*execution.CreatedComment, *execution.CommentIssue, workspaceID, actorID)
	}
	for _, activity := range execution.Activities {
		h.publishApprovalActivityCreated(activity, workspaceID, actorID)
	}
	if result.HasApprovalActivity {
		h.publishApprovalActivityCreated(result.ApprovalActivity, workspaceID, actorID)
	}
	h.publish(protocol.EventApprovalUpdated, workspaceID, actorType, actorID, map[string]any{"approval": resp})
	if execution.Status == "succeeded" {
		h.publish(protocol.EventApprovalExecutionSucceeded, workspaceID, actorType, actorID, map[string]any{"approval": resp})
	}
	if execution.Status == "failed" {
		h.publish(protocol.EventApprovalExecutionFailed, workspaceID, actorType, actorID, map[string]any{"approval": resp})
	}
}

func (h *Handler) RateAIApproval(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	approvalID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "approval id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req AIApprovalQualityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Score < 1 || req.Score > 5 {
		writeError(w, http.StatusBadRequest, "score must be between 1 and 5")
		return
	}
	userUUID := parseUUID(userID)
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	approval, err := qtx.GetAIApprovalInWorkspace(r.Context(), db.GetAIApprovalInWorkspaceParams{
		ID: approvalID, WorkspaceID: workspaceUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "approval not found")
		return
	}
	payload := map[string]any{
		"kind":    "quality_review",
		"score":   req.Score,
		"note":    strings.TrimSpace(req.Note),
		"outcome": strings.TrimSpace(req.Outcome),
	}
	if _, err := createAIApprovalEvent(r.Context(), qtx, approval, "member", userUUID, "edited", approval.Status, approval.Status, payload); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create quality event")
		return
	}
	if err := createAIApprovalEvidence(r.Context(), qtx, approval.WorkspaceID, approval.ID, CreateAIApprovalEvidenceRequest{
		EvidenceType: "log",
		Label:        "决策质量评分",
		RefID:        uuidToString(approval.ID),
		Quote:        approvalQualityQuote(req),
		Metadata:     payload,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create quality evidence")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	resp, ok := h.aiApprovalDetailResponse(w, r, approval)
	if !ok {
		return
	}
	h.publish(protocol.EventApprovalUpdated, workspaceID, "member", userID, map[string]any{"approval": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) ObserveAIApproval(w http.ResponseWriter, r *http.Request) {
	h.transitionAIApproval(w, r, "observe")
}

func (h *Handler) TakeOverAIApproval(w http.ResponseWriter, r *http.Request) {
	h.transitionAIApproval(w, r, "take_over")
}

func (h *Handler) transitionAIApproval(w http.ResponseWriter, r *http.Request, action string) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	approvalID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "approval id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req AIApprovalTransitionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	userUUID := parseUUID(userID)
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	existing, err := qtx.GetAIApprovalInWorkspace(r.Context(), db.GetAIApprovalInWorkspaceParams{
		ID: approvalID, WorkspaceID: workspaceUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "approval not found")
		return
	}
	var (
		updated   db.AiMeApproval
		eventType string
		proto     string
	)
	switch action {
	case "reject":
		updated, err = qtx.RejectAIApproval(r.Context(), db.RejectAIApprovalParams{
			RejectedBy: userUUID, RejectionReason: optionalTextFromString(req.Reason), ID: approvalID, WorkspaceID: workspaceUUID,
		})
		eventType = "rejected"
		proto = protocol.EventApprovalRejected
	case "observe":
		updated, err = qtx.ObserveAIApproval(r.Context(), db.ObserveAIApprovalParams{
			ObservedBy: userUUID, ApprovalNote: optionalTextFromString(req.Note), ID: approvalID, WorkspaceID: workspaceUUID,
		})
		eventType = "observing"
		proto = protocol.EventApprovalUpdated
	case "take_over":
		updated, err = qtx.TakeOverAIApproval(r.Context(), db.TakeOverAIApprovalParams{
			TakenOverBy: userUUID, ApprovalNote: optionalTextFromString(req.Note), ID: approvalID, WorkspaceID: workspaceUUID,
		})
		eventType = "taken_over"
		proto = protocol.EventApprovalUpdated
	}
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusConflict, "approval cannot transition in its current status")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to transition approval")
		return
	}
	if (action == "reject" || action == "take_over") && existing.ToolCallID.Valid {
		reason := firstNonEmpty(strings.TrimSpace(req.Reason), strings.TrimSpace(req.Note), "tool approval was not approved")
		outcome := "rejected"
		if action == "take_over" {
			outcome = "cancelled"
		}
		if err := finishAIMeToolCallAfterApproval(r.Context(), qtx, existing, approvedAIActionExecution{Status: outcome, ExecutionError: reason}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to finish AI-Me tool call")
			return
		}
	}
	payload := map[string]any{"note": req.Note, "reason": req.Reason}
	if _, err := createAIApprovalEvent(r.Context(), qtx, updated, "member", userUUID, eventType, existing.Status, updated.Status, payload); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create approval event")
		return
	}
	if _, _, err := recordAIApprovalActivity(r.Context(), qtx, updated, userUUID, "ai_me_approval_"+eventType, payload); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record approval activity")
		return
	}
	var archivedInboxItems []db.InboxItem
	if action == "reject" || action == "take_over" {
		archivedInboxItems, err = archiveAIApprovalInboxItems(r.Context(), qtx, updated)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to archive approval inbox item")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	resp := aiApprovalToResponse(updated)
	h.publish(proto, workspaceID, "member", userID, map[string]any{"approval": resp})
	h.publishArchivedAIApprovalInboxItems(workspaceID, userID, archivedInboxItems)
	writeJSON(w, http.StatusOK, resp)
}

func archiveAIApprovalInboxItems(ctx context.Context, q *db.Queries, approval db.AiMeApproval) ([]db.InboxItem, error) {
	return q.ArchiveInboxByApprovalID(ctx, db.ArchiveInboxByApprovalIDParams{
		WorkspaceID: approval.WorkspaceID,
		ApprovalID:  uuidToString(approval.ID),
	})
}

func (h *Handler) publishArchivedAIApprovalInboxItems(workspaceID, userID string, items []db.InboxItem) {
	for _, item := range items {
		h.publish(protocol.EventInboxArchived, workspaceID, "member", userID, map[string]any{
			"item_id":      uuidToString(item.ID),
			"issue_id":     uuidToPtr(item.IssueID),
			"recipient_id": uuidToString(item.RecipientID),
		})
	}
}

type approvedAIActionExecution struct {
	Status           string
	ExecutionError   string
	CreatedIssueID   pgtype.UUID
	CreatedTaskID    pgtype.UUID
	CreatedCommentID pgtype.UUID
	CreatedIssue     *db.Issue
	PreviousIssue    db.Issue
	UpdatedIssue     *db.Issue
	CreatedComment   *db.Comment
	CommentIssue     *db.Issue
	QueuedTask       *db.AgentTaskQueue
	CancelledTasks   []db.AgentTaskQueue
	Activities       []db.ActivityLog
}

func (h *Handler) executeApprovedAIActionInSavepoint(ctx context.Context, tx pgx.Tx, approval db.AiMeApproval, workspaceID, userID pgtype.UUID, payload []byte) approvedAIActionExecution {
	actionTx, err := tx.Begin(ctx)
	if err != nil {
		return approvedAIActionExecution{Status: "failed", ExecutionError: "failed to start approved action"}
	}
	qtx := h.Queries.WithTx(actionTx)
	execution, err := h.executeApprovedAIAction(ctx, qtx, approval, workspaceID, userID, payload)
	if err != nil {
		_ = actionTx.Rollback(ctx)
		return approvedAIActionExecution{Status: "failed", ExecutionError: err.Error()}
	}
	if err := actionTx.Commit(ctx); err != nil {
		_ = actionTx.Rollback(ctx)
		return approvedAIActionExecution{Status: "failed", ExecutionError: "failed to commit approved action"}
	}
	if execution.Status == "" {
		execution.Status = "succeeded"
	}
	return execution
}

// executeApprovedAIAction runs the audited command while the approval update
// transaction is still open. Realtime publication happens after commit so
// clients and daemons never observe rolled-back work.
func (h *Handler) executeApprovedAIAction(ctx context.Context, q *db.Queries, approval db.AiMeApproval, workspaceID, userID pgtype.UUID, payload []byte) (approvedAIActionExecution, error) {
	switch approval.ActionType {
	case "no_action":
		return approvedAIActionExecution{Status: "skipped"}, nil
	case "draft_reply":
		return approvedAIActionExecution{Status: "succeeded"}, nil
	case "create_issue":
		return h.executeApprovalCreateIssue(ctx, q, approval, workspaceID, userID, payload)
	case "send_external_message":
		return h.executeApprovalSendExternalMessage(ctx, approval, payload)
	case "post_internal_comment":
		return h.executeApprovalComment(ctx, q, approval, workspaceID, userID, payload)
	case "assign_worker":
		return h.executeApprovalAssignWorker(ctx, q, approval, workspaceID, userID, payload)
	default:
		return approvedAIActionExecution{}, errors.New("action_type is not executable in v0.1")
	}
}

func (h *Handler) executeApprovalCreateIssue(ctx context.Context, q *db.Queries, approval db.AiMeApproval, workspaceID, userID pgtype.UUID, payload []byte) (approvedAIActionExecution, error) {
	title := strings.TrimSpace(approvalPayloadText(payload, "title", "issue_title"))
	if title == "" {
		return approvedAIActionExecution{}, errors.New("title is required for create_issue")
	}
	status := strings.TrimSpace(approvalPayloadText(payload, "status"))
	if status == "" {
		status = "todo"
	}
	if status != "backlog" && status != "todo" {
		return approvedAIActionExecution{}, errors.New("create_issue status must be backlog or todo")
	}
	priority := strings.TrimSpace(approvalPayloadText(payload, "priority"))
	if priority == "" {
		priority = "none"
	}
	switch priority {
	case "urgent", "high", "medium", "low", "none":
	default:
		return approvedAIActionExecution{}, errors.New("invalid create_issue priority")
	}

	var assigneeType pgtype.Text
	var assigneeID pgtype.UUID
	var agent db.Agent
	targetAgent := approvalPayloadText(payload, "target_agent_id", "agent_id", "assignee_id", "worker_id") != "" ||
		approvalPayloadText(payload, "target_agent_name", "agent_name", "worker_name") != ""
	if targetAgent {
		var err error
		agent, err = h.resolveApprovalTargetAgent(ctx, q, workspaceID, userID, payload)
		if err != nil {
			return approvedAIActionExecution{}, err
		}
		if !agent.RuntimeID.Valid {
			return approvedAIActionExecution{}, errors.New("agent has no runtime")
		}
		assigneeType = pgtype.Text{String: "agent", Valid: true}
		assigneeID = agent.ID
	}
	if approval.ToolCallID.Valid {
		existing, err := q.GetIssueByOrigin(ctx, db.GetIssueByOriginParams{
			WorkspaceID: workspaceID,
			OriginType:  pgtype.Text{String: "ai_me", Valid: true},
			OriginID:    approval.ToolCallID,
		})
		if err == nil {
			execution := approvedAIActionExecution{Status: "succeeded", CreatedIssueID: existing.ID, CreatedIssue: &existing}
			tasks, taskErr := q.ListTasksByIssue(ctx, existing.ID)
			if taskErr == nil && len(tasks) > 0 {
				execution.CreatedTaskID = tasks[0].ID
				execution.QueuedTask = &tasks[0]
			}
			return execution, nil
		}
		if !isNotFound(err) {
			return approvedAIActionExecution{}, errors.New("failed to check existing AI-Me issue")
		}
	}

	issueNumber, err := q.IncrementIssueCounter(ctx, workspaceID)
	if err != nil {
		return approvedAIActionExecution{}, errors.New("failed to allocate issue number")
	}
	description := optionalTextFromString(approvalPayloadText(payload, "description", "body"))
	var issue db.Issue
	if approval.ToolCallID.Valid {
		issue, err = q.CreateIssueWithOrigin(ctx, db.CreateIssueWithOriginParams{
			WorkspaceID:   workspaceID,
			Title:         title,
			Description:   description,
			Status:        status,
			Priority:      priority,
			AssigneeType:  assigneeType,
			AssigneeID:    assigneeID,
			CreatorType:   "member",
			CreatorID:     userID,
			ParentIssueID: pgtype.UUID{},
			Position:      0,
			DueDate:       pgtype.Timestamptz{},
			Number:        issueNumber,
			ProjectID:     pgtype.UUID{},
			OriginType:    pgtype.Text{String: "ai_me", Valid: true},
			OriginID:      approval.ToolCallID,
			CodeContext:   []byte(`{}`),
		})
	} else {
		issue, err = q.CreateIssue(ctx, db.CreateIssueParams{
			WorkspaceID:   workspaceID,
			Title:         title,
			Description:   description,
			Status:        status,
			Priority:      priority,
			AssigneeType:  assigneeType,
			AssigneeID:    assigneeID,
			CreatorType:   "member",
			CreatorID:     userID,
			ParentIssueID: pgtype.UUID{},
			Position:      0,
			DueDate:       pgtype.Timestamptz{},
			Number:        issueNumber,
			ProjectID:     pgtype.UUID{},
			CodeContext:   []byte(`{}`),
		})
	}
	if err != nil {
		return approvedAIActionExecution{}, errors.New("failed to create issue")
	}

	execution := approvedAIActionExecution{
		Status:         "succeeded",
		CreatedIssueID: issue.ID,
		CreatedIssue:   &issue,
	}
	if assigneeID.Valid && status != "backlog" {
		task, err := q.CreateAgentTask(ctx, db.CreateAgentTaskParams{
			AgentID:   agent.ID,
			RuntimeID: agent.RuntimeID,
			IssueID:   issue.ID,
			Priority:  approvalPriorityToInt(priority),
			TriggerSummary: pgtype.Text{
				String: firstNonEmpty(approvalPayloadText(payload, "summary", "instruction"), approval.ActionDescription, approval.Summary),
				Valid:  true,
			},
		})
		if err != nil {
			return approvedAIActionExecution{}, errors.New("failed to create agent task")
		}
		execution.CreatedTaskID = task.ID
		execution.QueuedTask = &task
	}
	return execution, nil
}

func (h *Handler) executeApprovalSendExternalMessage(ctx context.Context, approval db.AiMeApproval, payload []byte) (approvedAIActionExecution, error) {
	channel := strings.ToLower(firstNonEmpty(
		approvalPayloadText(payload, "channel", "provider"),
		approval.SourceType,
	))
	if channel != "feishu" {
		return approvedAIActionExecution{}, errors.New("only feishu external messages are supported")
	}
	messageID := firstNonEmpty(
		approvalPayloadText(payload, "message_id", "feishu_message_id", "source_message_id"),
		approval.SourceRefID.String,
	)
	if messageID == "" {
		return approvedAIActionExecution{}, errors.New("message_id is required for send_external_message")
	}
	content := approvalPayloadText(payload, "text", "content", "reply_text", "reply_draft", "draft", "body")
	if content == "" {
		return approvedAIActionExecution{}, errors.New("text is required for send_external_message")
	}
	h.recordFeishuDeliverySending(ctx, approval, messageID)
	if h.Feishu == nil || !h.Feishu.Enabled() {
		err := errors.New("feishu client is not configured")
		h.recordFeishuDeliveryFailed(ctx, approval, err)
		return approvedAIActionExecution{}, err
	}
	resp, err := h.Feishu.ReplyText(ctx, messageID, content, feishuReplyIdempotencyKey(approval, messageID, content))
	if err != nil {
		h.recordFeishuDeliveryFailed(ctx, approval, err)
		return approvedAIActionExecution{}, err
	}
	h.recordFeishuDeliverySucceeded(ctx, approval, resp.MessageID)
	return approvedAIActionExecution{Status: "succeeded"}, nil
}

func feishuReplyIdempotencyKey(approval db.AiMeApproval, messageID, content string) string {
	if approvalID := uuidToString(approval.ID); approvalID != "" {
		return approvalID
	}
	return "aime-" + sha256Hex([]byte(messageID + "\n" + content))[:45]
}

func (h *Handler) executeApprovalComment(ctx context.Context, q *db.Queries, approval db.AiMeApproval, workspaceID, userID pgtype.UUID, payload []byte) (approvedAIActionExecution, error) {
	issueID := approval.IssueID
	if !issueID.Valid {
		if parsed, ok := approvalPayloadUUID(payload, "issue_id", "target_issue_id"); ok {
			issueID = parsed
		}
	}
	if !issueID.Valid {
		return approvedAIActionExecution{}, errors.New("issue_id is required for post_internal_comment")
	}
	issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return approvedAIActionExecution{}, errors.New("issue not found")
	}
	content := approvalPayloadText(payload, "content", "comment", "body", "reply_draft", "draft")
	if content == "" {
		content = strings.TrimSpace(approval.ActionDescription)
	}
	if content == "" {
		return approvedAIActionExecution{}, errors.New("comment content is required")
	}
	comment, err := q.CreateComment(ctx, db.CreateCommentParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		AuthorType:  "member",
		AuthorID:    userID,
		Content:     content,
		Type:        "comment",
	})
	if err != nil {
		return approvedAIActionExecution{}, errors.New("failed to create comment")
	}
	return approvedAIActionExecution{
		Status:           "succeeded",
		CreatedCommentID: comment.ID,
		CreatedComment:   &comment,
		CommentIssue:     &issue,
	}, nil
}

func (h *Handler) executeApprovalAssignWorker(ctx context.Context, q *db.Queries, approval db.AiMeApproval, workspaceID, userID pgtype.UUID, payload []byte) (approvedAIActionExecution, error) {
	issueID := approval.IssueID
	if !issueID.Valid {
		if parsed, ok := approvalPayloadUUID(payload, "issue_id", "target_issue_id"); ok {
			issueID = parsed
		}
	}
	if !issueID.Valid {
		return approvedAIActionExecution{}, errors.New("issue_id is required for assign_worker")
	}

	previousIssue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return approvedAIActionExecution{}, errors.New("issue not found")
	}
	if previousIssue.Status == "done" || previousIssue.Status == "cancelled" {
		return approvedAIActionExecution{}, errors.New("cannot assign a closed issue")
	}

	agent, err := h.resolveApprovalTargetAgent(ctx, q, workspaceID, userID, payload)
	if err != nil {
		return approvedAIActionExecution{}, err
	}
	if agent.ArchivedAt.Valid {
		return approvedAIActionExecution{}, errors.New("cannot assign to archived agent")
	}
	if !agent.RuntimeID.Valid {
		return approvedAIActionExecution{}, errors.New("agent has no runtime")
	}

	cancelled, err := q.CancelAgentTasksByIssue(ctx, previousIssue.ID)
	if err != nil {
		return approvedAIActionExecution{}, errors.New("failed to cancel existing agent tasks")
	}

	updatedIssue, err := q.UpdateIssue(ctx, db.UpdateIssueParams{
		ID:            previousIssue.ID,
		AssigneeType:  pgtype.Text{String: "agent", Valid: true},
		AssigneeID:    agent.ID,
		DueDate:       previousIssue.DueDate,
		ParentIssueID: previousIssue.ParentIssueID,
		ProjectID:     previousIssue.ProjectID,
	})
	if err != nil {
		return approvedAIActionExecution{}, errors.New("failed to assign issue to agent")
	}

	activity, err := h.recordApprovalAssigneeChangedActivity(ctx, q, approval, previousIssue, updatedIssue, userID)
	if err != nil {
		return approvedAIActionExecution{}, err
	}

	task, err := q.CreateAgentTask(ctx, db.CreateAgentTaskParams{
		AgentID:   agent.ID,
		RuntimeID: agent.RuntimeID,
		IssueID:   updatedIssue.ID,
		Priority:  approvalPriorityToInt(firstNonEmpty(approvalPayloadText(payload, "priority"), updatedIssue.Priority)),
		TriggerSummary: pgtype.Text{
			String: firstNonEmpty(approvalPayloadText(payload, "summary", "instruction"), approval.ActionDescription, approval.Summary),
			Valid:  true,
		},
	})
	if err != nil {
		return approvedAIActionExecution{}, errors.New("failed to create agent task")
	}

	return approvedAIActionExecution{
		Status:         "succeeded",
		CreatedTaskID:  task.ID,
		PreviousIssue:  previousIssue,
		UpdatedIssue:   &updatedIssue,
		QueuedTask:     &task,
		CancelledTasks: cancelled,
		Activities:     []db.ActivityLog{activity},
	}, nil
}

// resolveApprovalTargetAgent accepts either the stable agent UUID preferred by
// AI-Me or an exact name fallback for manually edited approvals.
func (h *Handler) resolveApprovalTargetAgent(ctx context.Context, q *db.Queries, workspaceID, userID pgtype.UUID, payload []byte) (db.Agent, error) {
	targetIDText := approvalPayloadText(payload, "target_agent_id", "agent_id", "assignee_id", "worker_id")
	if targetIDText != "" {
		targetID, err := parseUUIDLoose(targetIDText)
		if err != nil {
			return db.Agent{}, errors.New("target_agent_id must be a valid UUID")
		}
		agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: targetID, WorkspaceID: workspaceID})
		if err != nil {
			return db.Agent{}, errors.New("target agent not found in workspace")
		}
		if err := h.ensureApprovalAgentAssignable(ctx, agent, workspaceID, userID); err != nil {
			return db.Agent{}, err
		}
		return agent, nil
	}

	targetName := approvalPayloadText(payload, "target_agent_name", "agent_name", "worker_name")
	if targetName == "" {
		return db.Agent{}, errors.New("target_agent_id is required for assign_worker")
	}
	agents, err := q.ListAgents(ctx, workspaceID)
	if err != nil {
		return db.Agent{}, errors.New("failed to list agents")
	}
	for _, agent := range agents {
		if strings.EqualFold(strings.TrimSpace(agent.Name), targetName) {
			if err := h.ensureApprovalAgentAssignable(ctx, agent, workspaceID, userID); err != nil {
				return db.Agent{}, err
			}
			return agent, nil
		}
	}
	return db.Agent{}, errors.New("target agent not found in workspace")
}

// ensureApprovalAgentAssignable mirrors the issue update admission checks so
// AI-Me cannot bypass runtime availability or private-agent ownership rules.
func (h *Handler) ensureApprovalAgentAssignable(ctx context.Context, agent db.Agent, workspaceID, userID pgtype.UUID) error {
	if agent.ArchivedAt.Valid {
		return errors.New("cannot assign to archived agent")
	}
	if !agent.RuntimeID.Valid {
		return errors.New("agent has no runtime")
	}
	if !h.isRuntimeOnline(ctx, agent.RuntimeID) {
		return errors.New("agent's runtime is offline")
	}
	if agent.Visibility != "private" || agent.OwnerID == userID {
		return nil
	}
	member, err := h.getWorkspaceMember(ctx, uuidToString(userID), uuidToString(workspaceID))
	if err != nil || !roleAllowed(member.Role, "owner", "admin") {
		return errors.New("cannot assign to private agent")
	}
	return nil
}

// recordApprovalAssigneeChangedActivity feeds the same frequency signal used
// by manual assignment suggestions.
func (h *Handler) recordApprovalAssigneeChangedActivity(ctx context.Context, q *db.Queries, approval db.AiMeApproval, previousIssue, updatedIssue db.Issue, actorID pgtype.UUID) (db.ActivityLog, error) {
	details := map[string]any{
		"source":      "ai_me_approval",
		"approval_id": uuidToString(approval.ID),
		"from_type":   textToPtr(previousIssue.AssigneeType),
		"from_id":     uuidToPtr(previousIssue.AssigneeID),
		"to_type":     textToPtr(updatedIssue.AssigneeType),
		"to_id":       uuidToPtr(updatedIssue.AssigneeID),
	}
	activity, err := q.CreateActivity(ctx, db.CreateActivityParams{
		WorkspaceID: approval.WorkspaceID,
		IssueID:     updatedIssue.ID,
		ActorType:   pgtype.Text{String: "member", Valid: true},
		ActorID:     actorID,
		Action:      "assignee_changed",
		Details:     jsonBytesOrObject(details),
	})
	if err != nil {
		return db.ActivityLog{}, errors.New("failed to record assignee change")
	}
	return activity, nil
}

func approvalPriorityToInt(priority string) int32 {
	switch strings.TrimSpace(priority) {
	case "urgent":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func (h *Handler) publishApprovalIssueCreated(ctx context.Context, issue db.Issue, workspaceID, userID string) {
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	h.publish(protocol.EventIssueCreated, workspaceID, "member", userID, map[string]any{
		"issue": issueToResponse(issue, prefix),
	})
}

func (h *Handler) publishApprovalIssueUpdated(ctx context.Context, issue db.Issue, previousIssue db.Issue, workspaceID, userID string) {
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	resp := issueToResponse(issue, prefix)
	prevDueDate := timestampToPtr(previousIssue.DueDate)
	h.publish(protocol.EventIssueUpdated, workspaceID, "member", userID, map[string]any{
		"issue":               resp,
		"assignee_changed":    true,
		"status_changed":      false,
		"priority_changed":    false,
		"due_date_changed":    false,
		"description_changed": false,
		"title_changed":       false,
		"prev_title":          previousIssue.Title,
		"prev_assignee_type":  textToPtr(previousIssue.AssigneeType),
		"prev_assignee_id":    uuidToPtr(previousIssue.AssigneeID),
		"prev_status":         previousIssue.Status,
		"prev_priority":       previousIssue.Priority,
		"prev_due_date":       prevDueDate,
		"prev_description":    textToPtr(previousIssue.Description),
		"creator_type":        previousIssue.CreatorType,
		"creator_id":          uuidToString(previousIssue.CreatorID),
	})
}

// publishApprovalTaskQueued mirrors TaskService.EnqueueTaskForIssue after the
// approval transaction has committed.
func (h *Handler) publishApprovalTaskQueued(ctx context.Context, task db.AgentTaskQueue, workspaceID string) {
	h.publish(protocol.EventTaskQueued, workspaceID, "system", "", map[string]any{
		"task_id":  uuidToString(task.ID),
		"agent_id": uuidToString(task.AgentID),
		"issue_id": uuidToString(task.IssueID),
		"status":   task.Status,
	})
	if h.TaskService != nil {
		h.TaskService.NotifyTaskEnqueued(ctx, task)
	}
}

func (h *Handler) publishApprovalCommentCreated(comment db.Comment, issue db.Issue, workspaceID, userID string) {
	resp := commentToResponse(comment, nil, nil)
	h.publish(protocol.EventCommentCreated, workspaceID, "member", userID, map[string]any{
		"comment":             resp,
		"issue_title":         issue.Title,
		"issue_assignee_type": textToPtr(issue.AssigneeType),
		"issue_assignee_id":   uuidToPtr(issue.AssigneeID),
		"issue_status":        issue.Status,
	})
}

func (h *Handler) publishApprovalActivityCreated(activity db.ActivityLog, workspaceID, userID string) {
	h.publish(protocol.EventActivityCreated, workspaceID, "member", userID, map[string]any{
		"issue_id": uuidToString(activity.IssueID),
		"entry":    activityToEntry(activity),
	})
}

func (h *Handler) loadAIApproval(w http.ResponseWriter, r *http.Request) (db.AiMeApproval, bool) {
	workspaceID := parseUUID(h.resolveWorkspaceID(r))
	approvalID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "approval id")
	if !ok {
		return db.AiMeApproval{}, false
	}
	approval, err := h.Queries.GetAIApprovalInWorkspace(r.Context(), db.GetAIApprovalInWorkspaceParams{
		ID: approvalID, WorkspaceID: workspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "approval not found")
		return db.AiMeApproval{}, false
	}
	return approval, true
}

func (h *Handler) aiApprovalDetailResponse(w http.ResponseWriter, r *http.Request, approval db.AiMeApproval) (AIApprovalResponse, bool) {
	evidence, err := h.Queries.ListAIApprovalEvidence(r.Context(), db.ListAIApprovalEvidenceParams{
		ApprovalID: approval.ID, WorkspaceID: approval.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list approval evidence")
		return AIApprovalResponse{}, false
	}
	events, err := h.Queries.ListAIApprovalEvents(r.Context(), db.ListAIApprovalEventsParams{
		ApprovalID: approval.ID, WorkspaceID: approval.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list approval events")
		return AIApprovalResponse{}, false
	}
	resp := aiApprovalToResponse(approval)
	resp.Evidence = make([]AIApprovalEvidenceResponse, len(evidence))
	for i, item := range evidence {
		resp.Evidence[i] = aiApprovalEvidenceToResponse(item)
	}
	resp.Events = make([]AIApprovalEventResponse, len(events))
	for i, item := range events {
		resp.Events[i] = aiApprovalEventToResponse(item)
	}
	return resp, true
}

func createAIApprovalEvidence(ctx context.Context, q *db.Queries, workspaceID, approvalID pgtype.UUID, req CreateAIApprovalEvidenceRequest) error {
	evidenceType := normalizeOptionalEnum(req.EvidenceType, "user_input")
	if !approvalEvidenceTypes[evidenceType] {
		return errors.New("invalid evidence_type")
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		return errors.New("evidence label is required")
	}
	_, err := q.CreateAIApprovalEvidence(ctx, db.CreateAIApprovalEvidenceParams{
		ApprovalID:   approvalID,
		WorkspaceID:  workspaceID,
		EvidenceType: evidenceType,
		Label:        label,
		RefID:        optionalTextFromString(req.RefID),
		SourceUrl:    optionalTextFromString(req.SourceURL),
		Quote:        strings.TrimSpace(req.Quote),
		Metadata:     jsonBytesOrObject(req.Metadata),
	})
	return err
}

func createAIApprovalEvent(ctx context.Context, q *db.Queries, approval db.AiMeApproval, actorType string, actorID pgtype.UUID, eventType, fromStatus, toStatus string, payload any) (db.AiMeApprovalEvent, error) {
	return q.CreateAIApprovalEvent(ctx, db.CreateAIApprovalEventParams{
		ApprovalID:  approval.ID,
		WorkspaceID: approval.WorkspaceID,
		ActorType:   actorType,
		ActorID:     actorID,
		EventType:   eventType,
		FromStatus:  optionalTextFromString(fromStatus),
		ToStatus:    optionalTextFromString(toStatus),
		Payload:     jsonBytesOrObject(payload),
	})
}

func approvalExecutionEventPayload(approval db.AiMeApproval, execution approvedAIActionExecution) map[string]any {
	payload := map[string]any{
		"approval_id":      uuidToString(approval.ID),
		"action_type":      approval.ActionType,
		"execution_status": execution.Status,
	}
	if execution.ExecutionError != "" {
		payload["execution_error"] = execution.ExecutionError
	}
	if execution.CreatedIssueID.Valid {
		payload["created_issue_id"] = uuidToString(execution.CreatedIssueID)
	}
	if execution.CreatedTaskID.Valid {
		payload["created_task_id"] = uuidToString(execution.CreatedTaskID)
	}
	if execution.CreatedCommentID.Valid {
		payload["created_comment_id"] = uuidToString(execution.CreatedCommentID)
	}
	if messageID := approvalPayloadText(approval.FinalPayload, "message_id", "feishu_message_id", "source_message_id"); messageID != "" {
		payload["message_id"] = messageID
	}
	if channel := approvalPayloadText(approval.FinalPayload, "channel", "provider"); channel != "" {
		payload["channel"] = channel
	}
	return payload
}

func approvalExecutionEvidenceRequest(approval db.AiMeApproval, execution approvedAIActionExecution, payload map[string]any) CreateAIApprovalEvidenceRequest {
	label := "执行结果"
	quote := "审批动作已执行成功。"
	if execution.Status == "failed" {
		label = "执行失败"
		quote = execution.ExecutionError
		if quote == "" {
			quote = "审批动作执行失败，后端未返回详细原因。"
		}
	}
	refID := ""
	if execution.CreatedTaskID.Valid {
		refID = uuidToString(execution.CreatedTaskID)
	} else if execution.CreatedCommentID.Valid {
		refID = uuidToString(execution.CreatedCommentID)
	} else if messageID := approvalPayloadText(approval.FinalPayload, "message_id", "feishu_message_id", "source_message_id"); messageID != "" {
		refID = messageID
	}
	return CreateAIApprovalEvidenceRequest{
		EvidenceType: "log",
		Label:        label,
		RefID:        refID,
		Quote:        quote,
		Metadata:     payload,
	}
}

func approvalQualityQuote(req AIApprovalQualityRequest) string {
	parts := []string{fmt.Sprintf("评分：%d/5", req.Score)}
	if note := strings.TrimSpace(req.Note); note != "" {
		parts = append(parts, "备注："+note)
	}
	if outcome := strings.TrimSpace(req.Outcome); outcome != "" {
		parts = append(parts, "结果："+outcome)
	}
	return strings.Join(parts, "；")
}

func recordAIApprovalActivity(ctx context.Context, q *db.Queries, approval db.AiMeApproval, actorID pgtype.UUID, action string, payload any) (db.ActivityLog, bool, error) {
	if !approval.IssueID.Valid {
		return db.ActivityLog{}, false, nil
	}
	details := map[string]any{
		"approval_id": uuidToString(approval.ID),
		"action_type": approval.ActionType,
		"status":      approval.Status,
		"payload":     payload,
	}
	activity, err := q.CreateActivity(ctx, db.CreateActivityParams{
		WorkspaceID: approval.WorkspaceID,
		IssueID:     approval.IssueID,
		ActorType:   pgtype.Text{String: "member", Valid: true},
		ActorID:     actorID,
		Action:      action,
		Details:     jsonBytesOrObject(details),
	})
	if err != nil {
		return db.ActivityLog{}, false, err
	}
	return activity, true, nil
}

func rawJSONFromRequest(w http.ResponseWriter, value *json.RawMessage, fieldName string) ([]byte, bool) {
	if value == nil {
		return nil, true
	}
	raw := []byte(*value)
	if len(raw) == 0 || !json.Valid(raw) {
		writeError(w, http.StatusBadRequest, "invalid "+fieldName)
		return nil, false
	}
	return raw, true
}

func approvalEffectivePayload(approval db.AiMeApproval, override []byte) []byte {
	if len(override) > 0 {
		return override
	}
	if len(approval.FinalPayload) > 0 {
		return approval.FinalPayload
	}
	return approval.OriginalPayload
}

func approvalPayloadText(payload []byte, keys ...string) string {
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return ""
	}
	for _, key := range keys {
		if value, ok := obj[key].(string); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func approvalPayloadUUID(payload []byte, keys ...string) (pgtype.UUID, bool) {
	value := approvalPayloadText(payload, keys...)
	if value == "" {
		return pgtype.UUID{}, false
	}
	parsed, err := parseUUIDLoose(value)
	if err != nil {
		return pgtype.UUID{}, false
	}
	return parsed, true
}
