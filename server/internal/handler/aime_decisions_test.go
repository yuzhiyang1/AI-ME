package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestNormalizeAIApprovalQualityOutcome(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		execution string
		want      string
		wantErr   bool
	}{
		{name: "successful defaults to accepted", execution: "succeeded", want: "accepted"},
		{name: "failed defaults to retry", execution: "failed", want: "needs_retry"},
		{name: "skipped defaults to wrong", execution: "skipped", want: "wrong"},
		{name: "explicit valid outcome", raw: "needs_retry", execution: "succeeded", want: "needs_retry"},
		{name: "legacy execution status is rejected", raw: "failed", execution: "failed", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeAIApprovalQualityOutcome(tt.raw, db.AiMeApproval{ExecutionStatus: tt.execution})
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected outcome validation error")
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("outcome=%q err=%v, want %q", got, err, tt.want)
			}
		})
	}
}

func TestListAIMeDecisionsUsesTodayRunCostAndLatestReview(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	t.Setenv("AI_ME_DAILY_BUDGET_CENTS", "100")
	ctx := context.Background()

	var succeededRunID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, status, input, provider, model,
			step_count, max_steps, input_tokens, output_tokens, cache_read_tokens,
			cost_microusd, idempotency_key, started_at, completed_at
		) VALUES (
			$1, $2, 'ai_me_think', 'succeeded', '{}'::jsonb, 'deepseek', 'deepseek-test',
			2, 8, 1000, 200, 100, 120000, $3, now(), now()
		)
		RETURNING id
	`, testWorkspaceID, testUserID, "decision-ledger-success:"+randomID()).Scan(&succeededRunID); err != nil {
		t.Fatalf("create succeeded run: %v", err)
	}

	var failedRunID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_run (
			workspace_id, user_id, source, status, input, provider, model,
			step_count, max_steps, input_tokens, output_tokens, cache_read_tokens,
			cost_microusd, last_error, idempotency_key, started_at, completed_at
		) VALUES (
			$1, $2, 'feishu', 'failed', '{}'::jsonb, 'deepseek', 'deepseek-test',
			1, 8, 300, 50, 20, 10000, 'provider timeout', $3, now(), now()
		)
		RETURNING id
	`, testWorkspaceID, testUserID, "decision-ledger-failed:"+randomID()).Scan(&failedRunID); err != nil {
		t.Fatalf("create failed run: %v", err)
	}

	var approvalID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, title, summary, status,
			risk_level, confidence, reversibility, action_type, execution_status,
			executed_at, run_id
		) VALUES (
			$1, $2, 'ai_me_think', '核查退款回复', '已完成核查', 'approved',
			'medium', 0.9, 'reversible', 'no_action', 'succeeded', now(), $3
		)
		RETURNING id
	`, testWorkspaceID, testUserID, succeededRunID).Scan(&approvalID); err != nil {
		t.Fatalf("create linked approval: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO ai_me_approval_event (
			approval_id, workspace_id, actor_type, actor_id, event_type,
			from_status, to_status, payload
		) VALUES (
			$1, $2, 'member', $3, 'edited', 'approved', 'approved',
			'{"kind":"quality_review","score":4,"outcome":"accepted","note":"结果可用"}'::jsonb
		)
	`, approvalID, testWorkspaceID, testUserID); err != nil {
		t.Fatalf("create quality review: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_run WHERE id IN ($1, $2)`, succeededRunID, failedRunID)
	})

	w := httptest.NewRecorder()
	req := newRequest(http.MethodGet, "/api/ai-me/decisions?limit=20&offset=0", nil)
	testHandler.ListAIMeDecisions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListAIMeDecisions: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Summary struct {
			TodayRuns               int64   `json:"today_runs"`
			Succeeded               int64   `json:"succeeded"`
			Failed                  int64   `json:"failed"`
			Reviewed                int64   `json:"reviewed"`
			AvgScore                float64 `json:"avg_score"`
			Accepted                int64   `json:"accepted"`
			InputTokens             int64   `json:"input_tokens"`
			OutputTokens            int64   `json:"output_tokens"`
			CacheReadTokens         int64   `json:"cache_read_tokens"`
			CostMicrousd            int64   `json:"cost_microusd"`
			DailyBudgetMicrousd     int64   `json:"daily_budget_microusd"`
			RemainingBudgetMicrousd int64   `json:"remaining_budget_microusd"`
			BudgetConfigured        bool    `json:"budget_configured"`
			BudgetStatus            string  `json:"budget_status"`
		} `json:"summary"`
		Decisions []struct {
			ApprovalID     string  `json:"approval_id"`
			RunID          *string `json:"run_id"`
			CostMicrousd   int64   `json:"cost_microusd"`
			QualityScore   int32   `json:"quality_score"`
			QualityOutcome string  `json:"quality_outcome"`
			QualityNote    string  `json:"quality_note"`
		} `json:"decisions"`
		Total int64 `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
		t.Fatalf("decode decisions response: %v", err)
	}
	if response.Summary.TodayRuns != 2 || response.Summary.Succeeded != 1 || response.Summary.Failed != 1 {
		t.Fatalf("run summary = %#v", response.Summary)
	}
	if response.Summary.InputTokens != 1300 || response.Summary.OutputTokens != 250 || response.Summary.CacheReadTokens != 120 || response.Summary.CostMicrousd != 130000 {
		t.Fatalf("usage summary = %#v", response.Summary)
	}
	if response.Summary.Reviewed != 1 || response.Summary.AvgScore != 4 || response.Summary.Accepted != 1 {
		t.Fatalf("quality summary = %#v", response.Summary)
	}
	if response.Summary.DailyBudgetMicrousd != 1000000 || response.Summary.RemainingBudgetMicrousd != 870000 || !response.Summary.BudgetConfigured || response.Summary.BudgetStatus != "ok" {
		t.Fatalf("budget summary = %#v", response.Summary)
	}
	if response.Total != 1 || len(response.Decisions) != 1 {
		t.Fatalf("decisions total=%d rows=%#v", response.Total, response.Decisions)
	}
	decision := response.Decisions[0]
	if decision.ApprovalID != approvalID || decision.RunID == nil || *decision.RunID != succeededRunID || decision.CostMicrousd != 120000 {
		t.Fatalf("decision run data = %#v", decision)
	}
	if decision.QualityScore != 4 || decision.QualityOutcome != "accepted" || decision.QualityNote != "结果可用" {
		t.Fatalf("decision quality data = %#v", decision)
	}
}
