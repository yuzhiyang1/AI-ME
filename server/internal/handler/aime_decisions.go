package handler

import (
	"net/http"
	"strconv"
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type AIMeDecisionLedgerSummaryResponse struct {
	TodayRuns               int64   `json:"today_runs"`
	Succeeded               int64   `json:"succeeded"`
	Failed                  int64   `json:"failed"`
	Reviewed                int64   `json:"reviewed"`
	AvgScore                float64 `json:"avg_score"`
	Accepted                int64   `json:"accepted"`
	NeedsRetry              int64   `json:"needs_retry"`
	Wrong                   int64   `json:"wrong"`
	InputTokens             int64   `json:"input_tokens"`
	OutputTokens            int64   `json:"output_tokens"`
	CacheReadTokens         int64   `json:"cache_read_tokens"`
	CostMicrousd            int64   `json:"cost_microusd"`
	DailyBudgetCents        int64   `json:"daily_budget_cents"`
	DailyBudgetMicrousd     int64   `json:"daily_budget_microusd"`
	RemainingBudgetMicrousd int64   `json:"remaining_budget_microusd"`
	BudgetConfigured        bool    `json:"budget_configured"`
	BudgetStatus            string  `json:"budget_status"`
}

type AIMeDecisionResponse struct {
	ApprovalID      string  `json:"approval_id"`
	RunID           *string `json:"run_id"`
	Title           string  `json:"title"`
	SourceType      string  `json:"source_type"`
	Status          string  `json:"status"`
	ExecutionStatus string  `json:"execution_status"`
	RiskLevel       string  `json:"risk_level"`
	Confidence      float64 `json:"confidence"`
	Provider        string  `json:"provider"`
	Model           string  `json:"model"`
	InputTokens     int64   `json:"input_tokens"`
	OutputTokens    int64   `json:"output_tokens"`
	CacheReadTokens int64   `json:"cache_read_tokens"`
	CostMicrousd    int64   `json:"cost_microusd"`
	StepCount       int32   `json:"step_count"`
	MaxSteps        int32   `json:"max_steps"`
	QualityScore    int32   `json:"quality_score"`
	QualityOutcome  string  `json:"quality_outcome"`
	QualityNote     string  `json:"quality_note"`
	ReviewedAt      *string `json:"reviewed_at"`
	CreatedAt       string  `json:"created_at"`
	CompletedAt     *string `json:"completed_at"`
	LastError       string  `json:"last_error"`
}

type ListAIMeDecisionsResponse struct {
	Summary   AIMeDecisionLedgerSummaryResponse `json:"summary"`
	Decisions []AIMeDecisionResponse            `json:"decisions"`
	Total     int64                             `json:"total"`
}

func (h *Handler) ListAIMeDecisions(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	limit, offset := aimeDecisionPagination(r)
	rows, err := h.Queries.ListAIMeDecisions(r.Context(), db.ListAIMeDecisionsParams{
		WorkspaceID: workspaceUUID,
		Limit:       limit,
		Offset:      offset,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list AI-Me decisions")
		return
	}
	total, err := h.Queries.CountAIMeDecisions(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count AI-Me decisions")
		return
	}
	summary, err := h.Queries.GetAIMeDecisionLedgerSummary(r.Context(), workspaceUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load AI-Me decision summary")
		return
	}
	decisions := make([]AIMeDecisionResponse, len(rows))
	for i, row := range rows {
		decisions[i] = aimeDecisionToResponse(row)
	}
	writeJSON(w, http.StatusOK, ListAIMeDecisionsResponse{
		Summary:   aimeDecisionSummaryToResponse(summary),
		Decisions: decisions,
		Total:     total,
	})
}

func aimeDecisionPagination(r *http.Request) (int32, int32) {
	limit := int32(20)
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

func aimeDecisionToResponse(row db.ListAIMeDecisionsRow) AIMeDecisionResponse {
	return AIMeDecisionResponse{
		ApprovalID:      uuidToString(row.ApprovalID),
		RunID:           uuidToPtr(row.RunID),
		Title:           row.Title,
		SourceType:      row.SourceType,
		Status:          row.Status,
		ExecutionStatus: row.ExecutionStatus,
		RiskLevel:       row.RiskLevel,
		Confidence:      row.Confidence,
		Provider:        row.Provider,
		Model:           row.Model,
		InputTokens:     row.InputTokens,
		OutputTokens:    row.OutputTokens,
		CacheReadTokens: row.CacheReadTokens,
		CostMicrousd:    row.CostMicrousd,
		StepCount:       row.StepCount,
		MaxSteps:        row.MaxSteps,
		QualityScore:    row.QualityScore,
		QualityOutcome:  row.QualityOutcome,
		QualityNote:     row.QualityNote,
		ReviewedAt:      timestampToPtr(row.ReviewedAt),
		CreatedAt:       timestampToString(row.CreatedAt),
		CompletedAt:     timestampToPtr(row.CompletedAt),
		LastError:       row.LastError,
	}
}

func aimeDecisionSummaryToResponse(row db.GetAIMeDecisionLedgerSummaryRow) AIMeDecisionLedgerSummaryResponse {
	budgetCents, configured := aimeDailyBudgetCentsConfig()
	budgetMicrousd := budgetCents * 10_000
	remaining := budgetMicrousd - row.CostMicrousd
	if remaining < 0 {
		remaining = 0
	}
	status := "unconfigured"
	if configured {
		status = "ok"
		if row.CostMicrousd >= budgetMicrousd {
			status = "exceeded"
		} else if budgetMicrousd > 0 && row.CostMicrousd*100 >= budgetMicrousd*80 {
			status = "warning"
		}
	}
	return AIMeDecisionLedgerSummaryResponse{
		TodayRuns:               row.TodayRuns,
		Succeeded:               row.Succeeded,
		Failed:                  row.Failed,
		Reviewed:                row.Reviewed,
		AvgScore:                row.AvgScore,
		Accepted:                row.Accepted,
		NeedsRetry:              row.NeedsRetry,
		Wrong:                   row.Wrong,
		InputTokens:             row.InputTokens,
		OutputTokens:            row.OutputTokens,
		CacheReadTokens:         row.CacheReadTokens,
		CostMicrousd:            row.CostMicrousd,
		DailyBudgetCents:        budgetCents,
		DailyBudgetMicrousd:     budgetMicrousd,
		RemainingBudgetMicrousd: remaining,
		BudgetConfigured:        configured,
		BudgetStatus:            status,
	}
}
