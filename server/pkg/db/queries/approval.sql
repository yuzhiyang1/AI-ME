-- name: ListAIApprovals :many
SELECT *
FROM ai_me_approval
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('risk_level')::text IS NULL OR risk_level = sqlc.narg('risk_level')::text)
  AND (sqlc.narg('action_type')::text IS NULL OR action_type = sqlc.narg('action_type')::text)
  AND (sqlc.narg('source_type')::text IS NULL OR source_type = sqlc.narg('source_type')::text)
  AND (sqlc.narg('issue_id')::uuid IS NULL OR issue_id = sqlc.narg('issue_id')::uuid)
ORDER BY
    CASE risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
    created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountAIApprovals :one
SELECT count(*)::bigint
FROM ai_me_approval
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('risk_level')::text IS NULL OR risk_level = sqlc.narg('risk_level')::text)
  AND (sqlc.narg('action_type')::text IS NULL OR action_type = sqlc.narg('action_type')::text)
  AND (sqlc.narg('source_type')::text IS NULL OR source_type = sqlc.narg('source_type')::text)
  AND (sqlc.narg('issue_id')::uuid IS NULL OR issue_id = sqlc.narg('issue_id')::uuid);

-- name: GetAIApprovalStats :one
SELECT
    count(*)::bigint AS total,
    count(*) FILTER (WHERE status = 'pending')::bigint AS pending,
    count(*) FILTER (WHERE status = 'pending' AND risk_level = 'high')::bigint AS high_risk_pending,
    count(*) FILTER (WHERE status = 'observing')::bigint AS observing,
    count(*) FILTER (WHERE status = 'approved')::bigint AS approved,
    count(*) FILTER (WHERE status = 'rejected')::bigint AS rejected,
    count(*) FILTER (WHERE status = 'taken_over')::bigint AS taken_over,
    count(*) FILTER (WHERE status = 'expired')::bigint AS expired,
    count(*) FILTER (WHERE execution_status = 'succeeded')::bigint AS succeeded,
    count(*) FILTER (WHERE execution_status = 'failed')::bigint AS failed
FROM ai_me_approval
WHERE workspace_id = $1::uuid;

-- name: GetAIApprovalInWorkspace :one
SELECT *
FROM ai_me_approval
WHERE id = $1 AND workspace_id = $2;

-- name: ClaimAIApprovalExecutionRetry :one
UPDATE ai_me_approval SET
    execution_status = 'running',
    execution_error = '',
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'approved'
  AND execution_status = 'failed'
RETURNING *;

-- name: CreateAIApproval :one
INSERT INTO ai_me_approval (
    workspace_id,
    requester_user_id,
    source_type,
    source_ref_id,
    source_url,
    issue_id,
    inbox_item_id,
    task_queue_id,
    memory_id,
    title,
    summary,
    risk_level,
    confidence,
    reversibility,
    action_type,
    action_title,
    action_description,
    original_payload,
    final_payload,
    ai_reasoning_summary,
    expires_at,
    tool_call_id,
    run_id
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21, sqlc.narg('tool_call_id')::uuid,
    (
        SELECT id
        FROM ai_me_run
        WHERE id = sqlc.narg('run_id')::uuid
          AND workspace_id = $1::uuid
    )
)
RETURNING *;

-- name: LinkAIApprovalRun :one
UPDATE ai_me_approval AS approval SET
    run_id = run.id,
    updated_at = now()
FROM ai_me_run AS run
WHERE approval.id = sqlc.arg('approval_id')::uuid
  AND approval.workspace_id = sqlc.arg('workspace_id')::uuid
  AND run.id = sqlc.arg('run_id')::uuid
  AND run.workspace_id = approval.workspace_id
RETURNING approval.*;

-- name: LinkAIApprovalInboxItem :one
UPDATE ai_me_approval SET
    inbox_item_id = sqlc.arg('inbox_item_id')::uuid,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: UpdateAIApproval :one
UPDATE ai_me_approval SET
    title = COALESCE(sqlc.narg('title'), title),
    summary = COALESCE(sqlc.narg('summary'), summary),
    risk_level = COALESCE(sqlc.narg('risk_level'), risk_level),
    confidence = COALESCE(sqlc.narg('confidence'), confidence),
    reversibility = COALESCE(sqlc.narg('reversibility'), reversibility),
    action_title = COALESCE(sqlc.narg('action_title'), action_title),
    action_description = COALESCE(sqlc.narg('action_description'), action_description),
    final_payload = COALESCE(sqlc.narg('final_payload'), final_payload),
    approval_note = COALESCE(sqlc.narg('approval_note'), approval_note),
    expires_at = COALESCE(sqlc.narg('expires_at'), expires_at),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status IN ('pending', 'observing')
RETURNING *;

-- name: ApproveAIApproval :one
UPDATE ai_me_approval SET
    status = 'approved',
    approved_by = sqlc.arg('approved_by')::uuid,
    approved_at = now(),
    approval_note = COALESCE(sqlc.narg('approval_note'), approval_note),
    final_payload = COALESCE(sqlc.narg('final_payload'), final_payload),
    execution_status = sqlc.arg('execution_status')::text,
    execution_error = COALESCE(sqlc.narg('execution_error'), ''),
    executed_at = CASE
        WHEN sqlc.arg('execution_status')::text IN ('succeeded', 'failed', 'skipped') THEN now()
        ELSE executed_at
    END,
    created_issue_id = COALESCE(sqlc.narg('created_issue_id'), created_issue_id),
    created_task_id = COALESCE(sqlc.narg('created_task_id'), created_task_id),
    created_comment_id = COALESCE(sqlc.narg('created_comment_id'), created_comment_id),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status IN ('pending', 'observing')
RETURNING *;

-- name: RejectAIApproval :one
UPDATE ai_me_approval SET
    status = 'rejected',
    rejected_by = sqlc.arg('rejected_by')::uuid,
    rejected_at = now(),
    rejection_reason = COALESCE(sqlc.narg('rejection_reason'), ''),
    execution_status = 'skipped',
    executed_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status IN ('pending', 'observing')
RETURNING *;

-- name: ObserveAIApproval :one
UPDATE ai_me_approval SET
    status = 'observing',
    observed_by = sqlc.arg('observed_by')::uuid,
    observed_at = now(),
    approval_note = COALESCE(sqlc.narg('approval_note'), approval_note),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'pending'
RETURNING *;

-- name: TakeOverAIApproval :one
UPDATE ai_me_approval SET
    status = 'taken_over',
    taken_over_by = sqlc.arg('taken_over_by')::uuid,
    taken_over_at = now(),
    approval_note = COALESCE(sqlc.narg('approval_note'), approval_note),
    execution_status = 'skipped',
    executed_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status IN ('pending', 'observing')
RETURNING *;

-- name: MarkAIApprovalExecutionSucceeded :one
UPDATE ai_me_approval SET
    execution_status = 'succeeded',
    execution_error = '',
    executed_at = now(),
    created_issue_id = COALESCE(sqlc.narg('created_issue_id'), created_issue_id),
    created_task_id = COALESCE(sqlc.narg('created_task_id'), created_task_id),
    created_comment_id = COALESCE(sqlc.narg('created_comment_id'), created_comment_id),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: MarkAIApprovalExecutionFailed :one
UPDATE ai_me_approval SET
    execution_status = 'failed',
    execution_error = sqlc.arg('execution_error')::text,
    executed_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: CreateAIApprovalEvidence :one
INSERT INTO ai_me_approval_evidence (
    approval_id,
    workspace_id,
    evidence_type,
    label,
    ref_id,
    source_url,
    quote,
    metadata
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
)
RETURNING *;

-- name: ListAIApprovalEvidence :many
SELECT *
FROM ai_me_approval_evidence
WHERE approval_id = $1 AND workspace_id = $2
ORDER BY created_at ASC, id ASC;

-- name: CreateAIApprovalEvent :one
INSERT INTO ai_me_approval_event (
    approval_id,
    workspace_id,
    actor_type,
    actor_id,
    event_type,
    from_status,
    to_status,
    payload,
    created_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp()
)
RETURNING *;

-- name: ListAIApprovalEvents :many
SELECT *
FROM ai_me_approval_event
WHERE approval_id = $1 AND workspace_id = $2
ORDER BY created_at ASC, id ASC;

-- name: CountAIMeDecisions :one
SELECT count(*)::bigint
FROM ai_me_approval
WHERE workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListAIMeDecisions :many
WITH latest_quality AS (
    SELECT DISTINCT ON (approval_id)
        approval_id,
        CASE
            WHEN payload->>'score' ~ '^[1-5]$' THEN (payload->>'score')::int
            ELSE 0
        END AS quality_score,
        COALESCE(payload->>'outcome', '')::text AS quality_outcome,
        COALESCE(payload->>'note', '')::text AS quality_note,
        created_at AS reviewed_at
    FROM ai_me_approval_event
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND event_type = 'edited'
      AND payload->>'kind' = 'quality_review'
    ORDER BY approval_id, created_at DESC, id DESC
)
SELECT
    approval.id AS approval_id,
    approval.run_id,
    approval.title,
    approval.source_type,
    approval.status,
    approval.execution_status,
    approval.risk_level,
    approval.confidence::float8 AS confidence,
    COALESCE(run.provider, '')::text AS provider,
    COALESCE(run.model, '')::text AS model,
    COALESCE(run.input_tokens, 0)::bigint AS input_tokens,
    COALESCE(run.output_tokens, 0)::bigint AS output_tokens,
    COALESCE(run.cache_read_tokens, 0)::bigint AS cache_read_tokens,
    COALESCE(run.cost_microusd, 0)::bigint AS cost_microusd,
    COALESCE(run.step_count, 0)::int AS step_count,
    COALESCE(run.max_steps, 0)::int AS max_steps,
    COALESCE(quality.quality_score, 0)::int AS quality_score,
    COALESCE(quality.quality_outcome, '')::text AS quality_outcome,
    COALESCE(quality.quality_note, '')::text AS quality_note,
    quality.reviewed_at,
    approval.created_at,
    COALESCE(run.completed_at, approval.executed_at) AS completed_at,
    CASE
        WHEN COALESCE(run.last_error, '') <> '' THEN run.last_error
        ELSE approval.execution_error
    END::text AS last_error
FROM ai_me_approval AS approval
LEFT JOIN ai_me_run AS run
  ON run.id = approval.run_id
 AND run.workspace_id = approval.workspace_id
LEFT JOIN latest_quality AS quality ON quality.approval_id = approval.id
WHERE approval.workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY approval.created_at DESC, approval.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: GetAIMeDecisionLedgerSummary :one
WITH today_runs AS (
    SELECT status, input_tokens, output_tokens, cache_read_tokens, cost_microusd
    FROM ai_me_run
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND created_at >= date_trunc('day', now())
), latest_quality AS (
    SELECT DISTINCT ON (approval_id)
        approval_id,
        CASE
            WHEN payload->>'score' ~ '^[1-5]$' THEN (payload->>'score')::int
            ELSE 0
        END AS score,
        COALESCE(payload->>'outcome', '')::text AS outcome
    FROM ai_me_approval_event
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND event_type = 'edited'
      AND payload->>'kind' = 'quality_review'
    ORDER BY approval_id, created_at DESC, id DESC
)
SELECT
    (SELECT count(*) FROM today_runs)::bigint AS today_runs,
    (SELECT count(*) FROM today_runs WHERE status = 'succeeded')::bigint AS succeeded,
    (SELECT count(*) FROM today_runs WHERE status = 'failed')::bigint AS failed,
    (SELECT count(*) FROM latest_quality WHERE score > 0)::bigint AS reviewed,
    COALESCE((SELECT avg(NULLIF(score, 0)) FROM latest_quality), 0)::float8 AS avg_score,
    (SELECT count(*) FROM latest_quality WHERE outcome = 'accepted')::bigint AS accepted,
    (SELECT count(*) FROM latest_quality WHERE outcome = 'needs_retry')::bigint AS needs_retry,
    (SELECT count(*) FROM latest_quality WHERE outcome = 'wrong')::bigint AS wrong,
    COALESCE((SELECT sum(input_tokens) FROM today_runs), 0)::bigint AS input_tokens,
    COALESCE((SELECT sum(output_tokens) FROM today_runs), 0)::bigint AS output_tokens,
    COALESCE((SELECT sum(cache_read_tokens) FROM today_runs), 0)::bigint AS cache_read_tokens,
    COALESCE((SELECT sum(cost_microusd) FROM today_runs), 0)::bigint AS cost_microusd;
