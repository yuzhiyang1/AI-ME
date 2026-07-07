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
    expires_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21
)
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
