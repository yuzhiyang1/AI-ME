package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const aiMeRuntimeSweepInterval = 5 * time.Second

type persistedFeishuRunInput struct {
	Payload     feishuEventCallback     `json:"payload"`
	MessageText string                  `json:"message_text"`
	Gate        feishuInboundGateResult `json:"gate"`
	ItemID      string                  `json:"item_id"`
	ApprovalID  string                  `json:"approval_id"`
}

// RunAIMeRuntimeScheduler recovers queued and lease-expired AI-Me runs. The
// database is the source of truth; the ticker is only a wake-up mechanism.
func (h *Handler) RunAIMeRuntimeScheduler(ctx context.Context) {
	ticker := time.NewTicker(aiMeRuntimeSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.processDueAIMeRuns(ctx)
		}
	}
}

func (h *Handler) processDueAIMeRuns(ctx context.Context) {
	h.reconcileAIMeToolApprovalOutcomes(ctx)
	h.reconcileAIMeTaskContinuations(ctx)
	h.reconcileIncompleteAIMeTaskResultRuns(ctx)
	leaseOwner := "aime-worker-" + randomID()
	runs, err := h.Queries.ClaimDueAIMeRuns(ctx, db.ClaimDueAIMeRunsParams{LeaseOwner: leaseOwner, LeaseSeconds: 120, Limit: 10})
	if err != nil {
		slog.Warn("AI-Me run claim failed", "error", err)
		return
	}
	for _, claimed := range runs {
		run, err := h.Queries.StartAIMeRun(ctx, db.StartAIMeRunParams{ID: claimed.ID, WorkspaceID: claimed.WorkspaceID, LeaseOwner: leaseOwner})
		if err != nil {
			continue
		}
		switch run.Source {
		case "feishu":
			if err := h.resumeFeishuAIMeRun(ctx, run, leaseOwner); err != nil {
				_, _ = h.Queries.FailAIMeRun(ctx, db.FailAIMeRunParams{LastError: truncateText(err.Error(), 1000), ID: run.ID, WorkspaceID: run.WorkspaceID, LeaseOwner: leaseOwner})
				slog.Warn("AI-Me Feishu run recovery failed", "run_id", uuidToString(run.ID), "error", err)
			}
		case "task_result":
			if err := h.resumeAIMeTaskResultRun(ctx, run, leaseOwner); err != nil {
				retried, handleErr := h.handleAIMeTaskResultRunError(ctx, run, leaseOwner, err)
				if handleErr != nil {
					slog.Warn("AI-Me task result failure handling failed", "run_id", uuidToString(run.ID), "error", handleErr, "cause", err)
				} else if retried {
					slog.Warn("AI-Me task result run scheduled for retry", "run_id", uuidToString(run.ID), "error", err)
				} else {
					slog.Warn("AI-Me task result run escalated to human review", "run_id", uuidToString(run.ID), "error", err)
				}
			}
		default:
			_, _ = h.Queries.FailAIMeRun(ctx, db.FailAIMeRunParams{LastError: "unsupported queued AI-Me run source", ID: run.ID, WorkspaceID: run.WorkspaceID, LeaseOwner: leaseOwner})
		}
	}
}

func (h *Handler) reconcileAIMeToolApprovalOutcomes(ctx context.Context) {
	rows, err := h.Queries.ListUnsyncedAIMeToolApprovalOutcomes(ctx, 50)
	if err != nil {
		slog.Warn("AI-Me tool approval outcome reconciliation failed", "error", err)
		return
	}
	for _, row := range rows {
		run, runErr := h.Queries.GetAIMeRun(ctx, db.GetAIMeRunParams{ID: row.RunID, WorkspaceID: row.WorkspaceID})
		if runErr != nil {
			slog.Warn("AI-Me tool approval run reload failed", "run_id", uuidToString(row.RunID), "error", runErr)
			continue
		}
		call, callErr := h.Queries.GetAIMeToolCall(ctx, db.GetAIMeToolCallParams{ID: row.ToolCallID, WorkspaceID: row.WorkspaceID})
		if callErr != nil {
			slog.Warn("AI-Me tool approval call reload failed", "tool_call_id", uuidToString(row.ToolCallID), "error", callErr)
			continue
		}
		if err := h.syncFeishuApprovalFromToolOutcome(ctx, run, call); err != nil {
			slog.Warn("AI-Me outer Feishu approval synchronization failed", "run_id", uuidToString(run.ID), "tool_call_id", uuidToString(call.ID), "error", err)
		}
	}
}

func (h *Handler) reconcileIncompleteAIMeTaskResultRuns(ctx context.Context) {
	runs, err := h.Queries.ListIncompleteAIMeTaskResultRuns(ctx, 50)
	if err != nil {
		slog.Warn("AI-Me task result finalization reconciliation failed", "error", err)
		return
	}
	for _, run := range runs {
		if _, err := h.Queries.RecoverIncompleteAIMeTaskResultRun(ctx, db.RecoverIncompleteAIMeTaskResultRunParams{
			ID: run.ID, WorkspaceID: run.WorkspaceID,
		}); err != nil && !isNotFound(err) {
			slog.Warn("AI-Me incomplete task result recovery failed", "run_id", uuidToString(run.ID), "error", err)
		}
	}
}

func (h *Handler) reconcileAIMeTaskContinuations(ctx context.Context) {
	tasks, err := h.Queries.ListUncontinuedAIMeTerminalTasks(ctx, 50)
	if err != nil {
		slog.Warn("AI-Me task continuation reconciliation failed", "error", err)
		return
	}
	for _, task := range tasks {
		workspaceID := uuidToString(task.WorkspaceID)
		taskID := uuidToString(task.TaskID)
		if err := h.enqueueAIMeTaskContinuation(ctx, workspaceID, taskID); err != nil {
			slog.Warn("AI-Me task continuation recovery failed", "workspace_id", workspaceID, "task_id", taskID, "error", err)
		}
	}
}

func (h *Handler) resumeFeishuAIMeRun(ctx context.Context, run db.AiMeRun, leaseOwner string) error {
	var input persistedFeishuRunInput
	if err := json.Unmarshal(run.Input, &input); err != nil {
		return err
	}
	itemID, err := parseUUIDLoose(input.ItemID)
	if err != nil {
		return errors.New("persisted Feishu run has invalid item_id")
	}
	approvalID, err := parseUUIDLoose(input.ApprovalID)
	if err != nil {
		return errors.New("persisted Feishu run has invalid approval_id")
	}
	workspace, err := h.Queries.GetWorkspace(ctx, run.WorkspaceID)
	if err != nil {
		return err
	}
	if !run.UserID.Valid {
		return errors.New("persisted Feishu run has no requester")
	}
	recipient, err := h.getWorkspaceMember(ctx, uuidToString(run.UserID), uuidToString(run.WorkspaceID))
	if err != nil {
		return err
	}
	item, err := h.Queries.GetInboxItemInWorkspace(ctx, db.GetInboxItemInWorkspaceParams{ID: itemID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		return err
	}
	approval, err := h.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{ID: approvalID, WorkspaceID: run.WorkspaceID})
	if err != nil {
		return err
	}
	if approval.Status != "pending" {
		_, err := h.Queries.CancelAIMeRun(ctx, db.CancelAIMeRunParams{
			LastError: pgtype.Text{String: "linked approval is no longer pending", Valid: true},
			ID:        run.ID, WorkspaceID: run.WorkspaceID,
		})
		return err
	}
	draft := h.generateFeishuReplyDraftWithRun(ctx, workspace, recipient, input.Payload, input.MessageText, input.Gate, run.ID, leaseOwner)
	updated, err := h.enrichPendingFeishuApproval(ctx, item, approval, run.UserID, input.Payload, input.MessageText, input.Gate, draft)
	if err != nil {
		return err
	}
	h.publish(protocol.EventApprovalUpdated, uuidToString(run.WorkspaceID), "ai_me", uuidToString(run.UserID), map[string]any{"approval": aiApprovalToResponse(updated)})
	return nil
}
