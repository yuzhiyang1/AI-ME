package handler

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

var (
	memoryTypes = map[string]bool{
		"identity":          true,
		"preference":        true,
		"rule":              true,
		"project_fact":      true,
		"process":           true,
		"history":           true,
		"relationship":      true,
		"technical_context": true,
	}
	memoryStatuses = map[string]bool{
		"candidate": true,
		"active":    true,
		"rejected":  true,
		"archived":  true,
	}
	memorySensitivities = map[string]bool{
		"normal":     true,
		"private":    true,
		"restricted": true,
	}
	memoryScopeTypes = map[string]bool{
		"user":      true,
		"workspace": true,
		"project":   true,
		"agent":     true,
	}
	memoryExternalUsePolicies = map[string]bool{
		"never":         true,
		"with_approval": true,
		"allowed":       true,
	}
	memorySourceModes = map[string]bool{
		"manual":      true,
		"inferred":    true,
		"imported":    true,
		"integration": true,
	}
	knowledgeDocumentStatuses = map[string]bool{
		"queued":     true,
		"processing": true,
		"ready":      true,
		"failed":     true,
		"archived":   true,
	}
)

type MemoryEntryResponse struct {
	ID                string                   `json:"id"`
	WorkspaceID       string                   `json:"workspace_id"`
	OwnerUserID       *string                  `json:"owner_user_id"`
	ProjectID         *string                  `json:"project_id"`
	Type              string                   `json:"type"`
	Category          string                   `json:"category"`
	Title             string                   `json:"title"`
	Content           string                   `json:"content"`
	Summary           string                   `json:"summary"`
	Status            string                   `json:"status"`
	Confidence        float64                  `json:"confidence"`
	Sensitivity       string                   `json:"sensitivity"`
	ScopeType         string                   `json:"scope_type"`
	ScopeRefID        *string                  `json:"scope_ref_id"`
	ExternalUsePolicy string                   `json:"external_use_policy"`
	SourceMode        string                   `json:"source_mode"`
	CreatedByType     string                   `json:"created_by_type"`
	CreatedByID       *string                  `json:"created_by_id"`
	VerifiedBy        *string                  `json:"verified_by"`
	VerifiedAt        *string                  `json:"verified_at"`
	LastUsedAt        *string                  `json:"last_used_at"`
	ExpiresAt         *string                  `json:"expires_at"`
	ArchivedAt        *string                  `json:"archived_at"`
	CreatedAt         string                   `json:"created_at"`
	UpdatedAt         string                   `json:"updated_at"`
	Evidence          []MemoryEvidenceResponse `json:"evidence,omitempty"`
	Usage             []MemoryUsageResponse    `json:"usage,omitempty"`
}

type MemorySourceResponse struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspace_id"`
	SourceType  string          `json:"source_type"`
	SourceRefID *string         `json:"source_ref_id"`
	SourceURL   *string         `json:"source_url"`
	Title       string          `json:"title"`
	Excerpt     string          `json:"excerpt"`
	Metadata    json.RawMessage `json:"metadata"`
	CapturedAt  *string         `json:"captured_at"`
	CreatedAt   string          `json:"created_at"`
}

type MemoryEvidenceResponse struct {
	ID         string               `json:"id"`
	MemoryID   string               `json:"memory_id"`
	SourceID   string               `json:"source_id"`
	Excerpt    string               `json:"excerpt"`
	Location   string               `json:"location"`
	Confidence float64              `json:"confidence"`
	CreatedAt  string               `json:"created_at"`
	Source     MemorySourceResponse `json:"source"`
}

type MemoryUsageResponse struct {
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspace_id"`
	MemoryID      string  `json:"memory_id"`
	UsedByType    string  `json:"used_by_type"`
	UsedByID      *string `json:"used_by_id"`
	IssueID       *string `json:"issue_id"`
	TaskQueueID   *string `json:"task_queue_id"`
	ChatSessionID *string `json:"chat_session_id"`
	Action        string  `json:"action"`
	Outcome       string  `json:"outcome"`
	CreatedAt     string  `json:"created_at"`
}

type KnowledgeDocumentResponse struct {
	ID            string          `json:"id"`
	WorkspaceID   string          `json:"workspace_id"`
	Title         string          `json:"title"`
	SourceType    string          `json:"source_type"`
	SourceURL     *string         `json:"source_url"`
	AttachmentID  *string         `json:"attachment_id"`
	Status        string          `json:"status"`
	ImportedBy    *string         `json:"imported_by"`
	Metadata      json.RawMessage `json:"metadata"`
	LastIndexedAt *string         `json:"last_indexed_at"`
	CreatedAt     string          `json:"created_at"`
	UpdatedAt     string          `json:"updated_at"`
}

type CreateMemoryEvidenceRequest struct {
	SourceType  string   `json:"source_type"`
	SourceRefID string   `json:"source_ref_id"`
	SourceURL   string   `json:"source_url"`
	Title       string   `json:"title"`
	Excerpt     string   `json:"excerpt"`
	Metadata    any      `json:"metadata"`
	CapturedAt  string   `json:"captured_at"`
	Location    string   `json:"location"`
	Confidence  *float64 `json:"confidence"`
}

type CreateMemoryEntryRequest struct {
	OwnerUserID       string                        `json:"owner_user_id"`
	ProjectID         string                        `json:"project_id"`
	Type              string                        `json:"type"`
	Category          string                        `json:"category"`
	Title             string                        `json:"title"`
	Content           string                        `json:"content"`
	Summary           string                        `json:"summary"`
	Status            string                        `json:"status"`
	Confidence        *float64                      `json:"confidence"`
	Sensitivity       string                        `json:"sensitivity"`
	ScopeType         string                        `json:"scope_type"`
	ScopeRefID        string                        `json:"scope_ref_id"`
	ExternalUsePolicy string                        `json:"external_use_policy"`
	SourceMode        string                        `json:"source_mode"`
	ExpiresAt         string                        `json:"expires_at"`
	Evidence          []CreateMemoryEvidenceRequest `json:"evidence"`
}

type UpdateMemoryEntryRequest struct {
	OwnerUserID       *string  `json:"owner_user_id"`
	ProjectID         *string  `json:"project_id"`
	Type              *string  `json:"type"`
	Category          *string  `json:"category"`
	Title             *string  `json:"title"`
	Content           *string  `json:"content"`
	Summary           *string  `json:"summary"`
	Status            *string  `json:"status"`
	Confidence        *float64 `json:"confidence"`
	Sensitivity       *string  `json:"sensitivity"`
	ScopeType         *string  `json:"scope_type"`
	ScopeRefID        *string  `json:"scope_ref_id"`
	ExternalUsePolicy *string  `json:"external_use_policy"`
	ExpiresAt         *string  `json:"expires_at"`
}

type CreateKnowledgeDocumentRequest struct {
	Title        string `json:"title"`
	SourceType   string `json:"source_type"`
	SourceURL    string `json:"source_url"`
	AttachmentID string `json:"attachment_id"`
	Status       string `json:"status"`
	Metadata     any    `json:"metadata"`
}

func memoryEntryToResponse(m db.MemoryEntry) MemoryEntryResponse {
	return MemoryEntryResponse{
		ID:                uuidToString(m.ID),
		WorkspaceID:       uuidToString(m.WorkspaceID),
		OwnerUserID:       uuidToPtr(m.OwnerUserID),
		ProjectID:         uuidToPtr(m.ProjectID),
		Type:              m.Type,
		Category:          m.Category,
		Title:             m.Title,
		Content:           m.Content,
		Summary:           m.Summary,
		Status:            m.Status,
		Confidence:        numericToFloat64(m.Confidence),
		Sensitivity:       m.Sensitivity,
		ScopeType:         m.ScopeType,
		ScopeRefID:        uuidToPtr(m.ScopeRefID),
		ExternalUsePolicy: m.ExternalUsePolicy,
		SourceMode:        m.SourceMode,
		CreatedByType:     m.CreatedByType,
		CreatedByID:       uuidToPtr(m.CreatedByID),
		VerifiedBy:        uuidToPtr(m.VerifiedBy),
		VerifiedAt:        timestampToPtr(m.VerifiedAt),
		LastUsedAt:        timestampToPtr(m.LastUsedAt),
		ExpiresAt:         timestampToPtr(m.ExpiresAt),
		ArchivedAt:        timestampToPtr(m.ArchivedAt),
		CreatedAt:         timestampToString(m.CreatedAt),
		UpdatedAt:         timestampToString(m.UpdatedAt),
	}
}

func memoryEvidenceToResponse(e db.ListMemoryEvidenceRow) MemoryEvidenceResponse {
	source := MemorySourceResponse{
		ID:          uuidToString(e.SourceID),
		WorkspaceID: uuidToString(e.WorkspaceID),
		SourceType:  e.SourceType,
		SourceRefID: uuidToPtr(e.SourceRefID),
		SourceURL:   textToPtr(e.SourceUrl),
		Title:       e.SourceTitle,
		Excerpt:     e.SourceExcerpt,
		Metadata:    rawJSONOrObject(e.SourceMetadata),
		CapturedAt:  timestampToPtr(e.SourceCapturedAt),
		CreatedAt:   timestampToString(e.SourceCreatedAt),
	}
	return MemoryEvidenceResponse{
		ID:         uuidToString(e.ID),
		MemoryID:   uuidToString(e.MemoryID),
		SourceID:   uuidToString(e.SourceID),
		Excerpt:    e.Excerpt,
		Location:   e.Location,
		Confidence: numericToFloat64(e.Confidence),
		CreatedAt:  timestampToString(e.CreatedAt),
		Source:     source,
	}
}

func memoryUsageToResponse(u db.MemoryUsage) MemoryUsageResponse {
	return MemoryUsageResponse{
		ID:            uuidToString(u.ID),
		WorkspaceID:   uuidToString(u.WorkspaceID),
		MemoryID:      uuidToString(u.MemoryID),
		UsedByType:    u.UsedByType,
		UsedByID:      uuidToPtr(u.UsedByID),
		IssueID:       uuidToPtr(u.IssueID),
		TaskQueueID:   uuidToPtr(u.TaskQueueID),
		ChatSessionID: uuidToPtr(u.ChatSessionID),
		Action:        u.Action,
		Outcome:       u.Outcome,
		CreatedAt:     timestampToString(u.CreatedAt),
	}
}

func knowledgeDocumentToResponse(d db.KnowledgeDocument) KnowledgeDocumentResponse {
	return KnowledgeDocumentResponse{
		ID:            uuidToString(d.ID),
		WorkspaceID:   uuidToString(d.WorkspaceID),
		Title:         d.Title,
		SourceType:    d.SourceType,
		SourceURL:     textToPtr(d.SourceUrl),
		AttachmentID:  uuidToPtr(d.AttachmentID),
		Status:        d.Status,
		ImportedBy:    uuidToPtr(d.ImportedBy),
		Metadata:      rawJSONOrObject(d.Metadata),
		LastIndexedAt: timestampToPtr(d.LastIndexedAt),
		CreatedAt:     timestampToString(d.CreatedAt),
		UpdatedAt:     timestampToString(d.UpdatedAt),
	}
}

func rawJSONOrObject(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(raw)
}

func numericToFloat64(n pgtype.Numeric) float64 {
	value, err := n.Float64Value()
	if err != nil || !value.Valid || math.IsNaN(value.Float64) || math.IsInf(value.Float64, 0) {
		return 0
	}
	return value.Float64
}

func numericFromFloat64(value float64) (pgtype.Numeric, error) {
	if value < 0 || value > 1 || math.IsNaN(value) || math.IsInf(value, 0) {
		return pgtype.Numeric{}, errors.New("value must be between 0 and 1")
	}
	var n pgtype.Numeric
	if err := n.Scan(strconv.FormatFloat(value, 'f', 3, 64)); err != nil {
		return pgtype.Numeric{}, err
	}
	return n, nil
}

func optionalNumericFromFloat64(value *float64) (pgtype.Numeric, error) {
	if value == nil {
		return pgtype.Numeric{}, nil
	}
	return numericFromFloat64(*value)
}

func jsonBytesOrObject(value any) []byte {
	if value == nil {
		return []byte("{}")
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) == 0 {
		return []byte("{}")
	}
	return raw
}

func optionalUUIDFromString(w http.ResponseWriter, value, fieldName string) (pgtype.UUID, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.UUID{}, true
	}
	return parseUUIDOrBadRequest(w, value, fieldName)
}

func optionalTextFromString(value string) pgtype.Text {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func optionalTimestampFromString(w http.ResponseWriter, value, fieldName string) (pgtype.Timestamptz, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.Timestamptz{}, true
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid "+fieldName)
		return pgtype.Timestamptz{}, false
	}
	return pgtype.Timestamptz{Time: parsed, Valid: true}, true
}

func optionalTextFromPtr(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: strings.TrimSpace(*value), Valid: true}
}

func optionalUUIDFromPtr(w http.ResponseWriter, value *string, fieldName string) (pgtype.UUID, bool) {
	if value == nil {
		return pgtype.UUID{}, true
	}
	return optionalUUIDFromString(w, *value, fieldName)
}

func optionalTimestampFromPtr(w http.ResponseWriter, value *string, fieldName string) (pgtype.Timestamptz, bool) {
	if value == nil {
		return pgtype.Timestamptz{}, true
	}
	return optionalTimestampFromString(w, *value, fieldName)
}

func validateEnum(w http.ResponseWriter, value, fieldName string, allowed map[string]bool) bool {
	if !allowed[value] {
		writeError(w, http.StatusBadRequest, "invalid "+fieldName)
		return false
	}
	return true
}

func normalizeOptionalEnum(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func listPagination(r *http.Request) (int32, int32) {
	limit := int32(50)
	offset := int32(0)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 200 {
			limit = int32(parsed)
		}
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = int32(parsed)
		}
	}
	return limit, offset
}

func memoryListParams(w http.ResponseWriter, r *http.Request, workspaceID string) (db.ListMemoryEntriesParams, bool) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return db.ListMemoryEntriesParams{}, false
	}
	limit, offset := listPagination(r)
	status := optionalTextFromString(r.URL.Query().Get("status"))
	if status.Valid && !validateEnum(w, status.String, "status", memoryStatuses) {
		return db.ListMemoryEntriesParams{}, false
	}
	memoryType := optionalTextFromString(r.URL.Query().Get("type"))
	if memoryType.Valid && !validateEnum(w, memoryType.String, "type", memoryTypes) {
		return db.ListMemoryEntriesParams{}, false
	}
	category := optionalTextFromString(r.URL.Query().Get("category"))
	query := optionalTextFromString(r.URL.Query().Get("q"))
	return db.ListMemoryEntriesParams{
		WorkspaceID: workspaceUUID,
		Status:      status,
		Type:        memoryType,
		Category:    category,
		Query:       query,
		Limit:       limit,
		Offset:      offset,
	}, true
}

func (h *Handler) ListMemoryEntries(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	params, ok := memoryListParams(w, r, workspaceID)
	if !ok {
		return
	}
	countParams := db.CountMemoryEntriesParams{
		WorkspaceID: params.WorkspaceID,
		Status:      params.Status,
		Type:        params.Type,
		Category:    params.Category,
		Query:       params.Query,
	}
	memories, err := h.Queries.ListMemoryEntries(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list memories")
		return
	}
	total, err := h.Queries.CountMemoryEntries(r.Context(), countParams)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count memories")
		return
	}
	resp := make([]MemoryEntryResponse, len(memories))
	for i, memory := range memories {
		resp[i] = memoryEntryToResponse(memory)
	}
	writeJSON(w, http.StatusOK, map[string]any{"memories": resp, "total": total})
}

func (h *Handler) GetMemoryEntry(w http.ResponseWriter, r *http.Request) {
	workspaceID := parseUUID(h.resolveWorkspaceID(r))
	memoryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "memory id")
	if !ok {
		return
	}
	memory, err := h.Queries.GetMemoryEntryInWorkspace(r.Context(), db.GetMemoryEntryInWorkspaceParams{
		ID: memoryID, WorkspaceID: workspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "memory not found")
		return
	}
	evidence, err := h.Queries.ListMemoryEvidence(r.Context(), memory.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list memory evidence")
		return
	}
	usage, err := h.Queries.ListMemoryUsage(r.Context(), db.ListMemoryUsageParams{MemoryID: memory.ID, Limit: 20})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list memory usage")
		return
	}
	resp := memoryEntryToResponse(memory)
	resp.Evidence = make([]MemoryEvidenceResponse, len(evidence))
	for i, item := range evidence {
		resp.Evidence[i] = memoryEvidenceToResponse(item)
	}
	resp.Usage = make([]MemoryUsageResponse, len(usage))
	for i, item := range usage {
		resp.Usage[i] = memoryUsageToResponse(item)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) CreateMemoryEntry(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateMemoryEntryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Type = strings.TrimSpace(req.Type)
	if !validateEnum(w, req.Type, "type", memoryTypes) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Content = strings.TrimSpace(req.Content)
	if req.Title == "" || req.Content == "" {
		writeError(w, http.StatusBadRequest, "title and content are required")
		return
	}
	status := normalizeOptionalEnum(req.Status, "active")
	if !validateEnum(w, status, "status", memoryStatuses) {
		return
	}
	sensitivity := normalizeOptionalEnum(req.Sensitivity, "normal")
	if !validateEnum(w, sensitivity, "sensitivity", memorySensitivities) {
		return
	}
	scopeType := normalizeOptionalEnum(req.ScopeType, "workspace")
	if !validateEnum(w, scopeType, "scope_type", memoryScopeTypes) {
		return
	}
	externalUsePolicy := normalizeOptionalEnum(req.ExternalUsePolicy, "never")
	if !validateEnum(w, externalUsePolicy, "external_use_policy", memoryExternalUsePolicies) {
		return
	}
	sourceMode := normalizeOptionalEnum(req.SourceMode, "manual")
	if !validateEnum(w, sourceMode, "source_mode", memorySourceModes) {
		return
	}
	confidence := 0.5
	if req.Confidence != nil {
		confidence = *req.Confidence
	}
	confidenceNumeric, err := numericFromFloat64(confidence)
	if err != nil {
		writeError(w, http.StatusBadRequest, "confidence must be between 0 and 1")
		return
	}
	ownerUUID, ok := optionalUUIDFromString(w, req.OwnerUserID, "owner_user_id")
	if !ok {
		return
	}
	projectUUID, ok := optionalUUIDFromString(w, req.ProjectID, "project_id")
	if !ok {
		return
	}
	scopeRefUUID, ok := optionalUUIDFromString(w, req.ScopeRefID, "scope_ref_id")
	if !ok {
		return
	}
	expiresAt, ok := optionalTimestampFromString(w, req.ExpiresAt, "expires_at")
	if !ok {
		return
	}
	creatorUUID := parseUUID(userID)

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	memory, err := qtx.CreateMemoryEntry(r.Context(), db.CreateMemoryEntryParams{
		WorkspaceID:       workspaceUUID,
		OwnerUserID:       ownerUUID,
		ProjectID:         projectUUID,
		Type:              req.Type,
		Category:          strings.TrimSpace(req.Category),
		Title:             req.Title,
		Content:           req.Content,
		Summary:           strings.TrimSpace(req.Summary),
		Status:            status,
		Confidence:        confidenceNumeric,
		Sensitivity:       sensitivity,
		ScopeType:         scopeType,
		ScopeRefID:        scopeRefUUID,
		ExternalUsePolicy: externalUsePolicy,
		SourceMode:        sourceMode,
		CreatedByType:     "member",
		CreatedByID:       creatorUUID,
		ExpiresAt:         expiresAt,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create memory")
		return
	}
	for _, evidenceReq := range req.Evidence {
		if err := h.createMemoryEvidence(r.Context(), qtx, workspaceUUID, memory.ID, evidenceReq); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	resp := memoryEntryToResponse(memory)
	h.publish(protocol.EventMemoryCreated, workspaceID, "member", userID, map[string]any{"memory": resp})
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) createMemoryEvidence(ctx context.Context, q *db.Queries, workspaceID, memoryID pgtype.UUID, req CreateMemoryEvidenceRequest) error {
	sourceType := strings.TrimSpace(req.SourceType)
	if sourceType == "" {
		return errors.New("evidence source_type is required")
	}
	sourceRefID, err := parseOptionalUUIDForMemory(req.SourceRefID)
	if err != nil {
		return errors.New("invalid evidence source_ref_id")
	}
	capturedAt, err := parseOptionalTimestampForMemory(req.CapturedAt)
	if err != nil {
		return errors.New("invalid evidence captured_at")
	}
	confidence := 0.5
	if req.Confidence != nil {
		confidence = *req.Confidence
	}
	confidenceNumeric, err := numericFromFloat64(confidence)
	if err != nil {
		return errors.New("evidence confidence must be between 0 and 1")
	}
	source, err := q.CreateMemorySource(ctx, db.CreateMemorySourceParams{
		WorkspaceID: workspaceID,
		SourceType:  sourceType,
		SourceRefID: sourceRefID,
		SourceUrl:   optionalTextFromString(req.SourceURL),
		Title:       strings.TrimSpace(req.Title),
		Excerpt:     strings.TrimSpace(req.Excerpt),
		Metadata:    jsonBytesOrObject(req.Metadata),
		CapturedAt:  capturedAt,
	})
	if err != nil {
		return err
	}
	_, err = q.CreateMemoryEvidence(ctx, db.CreateMemoryEvidenceParams{
		MemoryID:   memoryID,
		SourceID:   source.ID,
		Excerpt:    strings.TrimSpace(req.Excerpt),
		Location:   strings.TrimSpace(req.Location),
		Confidence: confidenceNumeric,
	})
	return err
}

func parseOptionalUUIDForMemory(value string) (pgtype.UUID, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.UUID{}, nil
	}
	return parseUUIDLoose(value)
}

func parseOptionalTimestampForMemory(value string) (pgtype.Timestamptz, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return pgtype.Timestamptz{}, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return pgtype.Timestamptz{}, err
	}
	return pgtype.Timestamptz{Time: parsed, Valid: true}, nil
}

func (h *Handler) UpdateMemoryEntry(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	memoryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "memory id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req UpdateMemoryEntryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	params := db.UpdateMemoryEntryParams{ID: memoryID, WorkspaceID: workspaceUUID}
	if req.OwnerUserID != nil {
		params.OwnerUserID, ok = optionalUUIDFromPtr(w, req.OwnerUserID, "owner_user_id")
		if !ok {
			return
		}
	}
	if req.ProjectID != nil {
		params.ProjectID, ok = optionalUUIDFromPtr(w, req.ProjectID, "project_id")
		if !ok {
			return
		}
	}
	if req.Type != nil {
		value := strings.TrimSpace(*req.Type)
		if !validateEnum(w, value, "type", memoryTypes) {
			return
		}
		params.Type = pgtype.Text{String: value, Valid: true}
	}
	params.Category = optionalTextFromPtr(req.Category)
	if req.Title != nil {
		value := strings.TrimSpace(*req.Title)
		if value == "" {
			writeError(w, http.StatusBadRequest, "title cannot be empty")
			return
		}
		params.Title = pgtype.Text{String: value, Valid: true}
	}
	if req.Content != nil {
		value := strings.TrimSpace(*req.Content)
		if value == "" {
			writeError(w, http.StatusBadRequest, "content cannot be empty")
			return
		}
		params.Content = pgtype.Text{String: value, Valid: true}
	}
	params.Summary = optionalTextFromPtr(req.Summary)
	if req.Status != nil {
		value := strings.TrimSpace(*req.Status)
		if !validateEnum(w, value, "status", memoryStatuses) {
			return
		}
		params.Status = pgtype.Text{String: value, Valid: true}
	}
	if req.Confidence != nil {
		n, err := optionalNumericFromFloat64(req.Confidence)
		if err != nil {
			writeError(w, http.StatusBadRequest, "confidence must be between 0 and 1")
			return
		}
		params.Confidence = n
	}
	if req.Sensitivity != nil {
		value := strings.TrimSpace(*req.Sensitivity)
		if !validateEnum(w, value, "sensitivity", memorySensitivities) {
			return
		}
		params.Sensitivity = pgtype.Text{String: value, Valid: true}
	}
	if req.ScopeType != nil {
		value := strings.TrimSpace(*req.ScopeType)
		if !validateEnum(w, value, "scope_type", memoryScopeTypes) {
			return
		}
		params.ScopeType = pgtype.Text{String: value, Valid: true}
	}
	if req.ScopeRefID != nil {
		params.ScopeRefID, ok = optionalUUIDFromPtr(w, req.ScopeRefID, "scope_ref_id")
		if !ok {
			return
		}
	}
	if req.ExternalUsePolicy != nil {
		value := strings.TrimSpace(*req.ExternalUsePolicy)
		if !validateEnum(w, value, "external_use_policy", memoryExternalUsePolicies) {
			return
		}
		params.ExternalUsePolicy = pgtype.Text{String: value, Valid: true}
	}
	if req.ExpiresAt != nil {
		params.ExpiresAt, ok = optionalTimestampFromPtr(w, req.ExpiresAt, "expires_at")
		if !ok {
			return
		}
	}
	memory, err := h.Queries.UpdateMemoryEntry(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusNotFound, "memory not found")
		return
	}
	resp := memoryEntryToResponse(memory)
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publish(protocol.EventMemoryUpdated, workspaceID, actorType, actorID, map[string]any{"memory": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) ConfirmMemoryEntry(w http.ResponseWriter, r *http.Request) {
	h.transitionMemory(w, r, "confirm")
}

func (h *Handler) RejectMemoryEntry(w http.ResponseWriter, r *http.Request) {
	h.transitionMemory(w, r, "reject")
}

func (h *Handler) ArchiveMemoryEntry(w http.ResponseWriter, r *http.Request) {
	h.transitionMemory(w, r, "archive")
}

func (h *Handler) VerifyMemoryEntry(w http.ResponseWriter, r *http.Request) {
	h.transitionMemory(w, r, "verify")
}

func (h *Handler) transitionMemory(w http.ResponseWriter, r *http.Request, action string) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	memoryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "memory id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	userUUID := parseUUID(userID)
	var (
		memory db.MemoryEntry
		err    error
		event  string
	)
	switch action {
	case "confirm":
		memory, err = h.Queries.ConfirmMemoryEntry(r.Context(), db.ConfirmMemoryEntryParams{ID: memoryID, WorkspaceID: workspaceUUID, VerifiedBy: userUUID})
		event = protocol.EventMemoryConfirmed
	case "reject":
		memory, err = h.Queries.RejectMemoryEntry(r.Context(), db.RejectMemoryEntryParams{ID: memoryID, WorkspaceID: workspaceUUID})
		event = protocol.EventMemoryRejected
	case "archive":
		memory, err = h.Queries.ArchiveMemoryEntry(r.Context(), db.ArchiveMemoryEntryParams{ID: memoryID, WorkspaceID: workspaceUUID})
		event = protocol.EventMemoryArchived
	case "verify":
		memory, err = h.Queries.VerifyMemoryEntry(r.Context(), db.VerifyMemoryEntryParams{ID: memoryID, WorkspaceID: workspaceUUID, VerifiedBy: userUUID})
		event = protocol.EventMemoryVerified
	}
	if err != nil {
		writeError(w, http.StatusNotFound, "memory not found")
		return
	}
	resp := memoryEntryToResponse(memory)
	h.publish(event, workspaceID, "member", userID, map[string]any{"memory": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) ListKnowledgeDocuments(w http.ResponseWriter, r *http.Request) {
	workspaceID := parseUUID(h.resolveWorkspaceID(r))
	limit, offset := listPagination(r)
	status := optionalTextFromString(r.URL.Query().Get("status"))
	if status.Valid && !validateEnum(w, status.String, "status", knowledgeDocumentStatuses) {
		return
	}
	docs, err := h.Queries.ListKnowledgeDocuments(r.Context(), db.ListKnowledgeDocumentsParams{
		WorkspaceID: workspaceID,
		Status:      status,
		Limit:       limit,
		Offset:      offset,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge documents")
		return
	}
	resp := make([]KnowledgeDocumentResponse, len(docs))
	for i, doc := range docs {
		resp[i] = knowledgeDocumentToResponse(doc)
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": resp, "total": len(resp)})
}

func (h *Handler) CreateKnowledgeDocument(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID := parseUUID(workspaceID)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateKnowledgeDocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	sourceType := normalizeOptionalEnum(req.SourceType, "manual")
	status := normalizeOptionalEnum(req.Status, "queued")
	if !validateEnum(w, status, "status", knowledgeDocumentStatuses) {
		return
	}
	attachmentID, ok := optionalUUIDFromString(w, req.AttachmentID, "attachment_id")
	if !ok {
		return
	}
	doc, err := h.Queries.CreateKnowledgeDocument(r.Context(), db.CreateKnowledgeDocumentParams{
		WorkspaceID:  workspaceUUID,
		Title:        req.Title,
		SourceType:   sourceType,
		SourceUrl:    optionalTextFromString(req.SourceURL),
		AttachmentID: attachmentID,
		Status:       status,
		ImportedBy:   parseUUID(userID),
		Metadata:     jsonBytesOrObject(req.Metadata),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge document")
		return
	}
	resp := knowledgeDocumentToResponse(doc)
	h.publish(protocol.EventKnowledgeDocumentCreated, workspaceID, "member", userID, map[string]any{"document": resp})
	writeJSON(w, http.StatusCreated, resp)
}
