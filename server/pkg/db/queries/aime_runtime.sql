-- name: CreateAIMeRun :one
-- The no-op conflict update returns the original row without replacing the
-- snapshots captured by the first request for an idempotency key.
INSERT INTO ai_me_run (
    workspace_id,
    user_id,
    source,
    input,
    context_snapshot,
    policy_snapshot,
    provider,
    model,
    max_steps,
    idempotency_key,
    next_wake_at
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.narg('user_id')::uuid,
    sqlc.arg('source')::text,
    sqlc.arg('input')::jsonb,
    sqlc.arg('context_snapshot')::jsonb,
    sqlc.arg('policy_snapshot')::jsonb,
    sqlc.arg('provider')::text,
    sqlc.arg('model')::text,
    sqlc.arg('max_steps')::int,
    sqlc.arg('idempotency_key')::text,
    sqlc.narg('next_wake_at')::timestamptz
)
ON CONFLICT (workspace_id, idempotency_key)
DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
RETURNING *;

-- name: GetAIMeRun :one
SELECT *
FROM ai_me_run
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: FindAIMeRunByIdempotencyKey :one
SELECT *
FROM ai_me_run
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND idempotency_key = sqlc.arg('idempotency_key')::text;

-- name: ListAIMeRuns :many
SELECT *
FROM ai_me_run
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('user_id')::uuid IS NULL OR user_id = sqlc.narg('user_id')::uuid)
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: ClaimDueAIMeRuns :many
-- Claiming and leasing happen in one statement so concurrent workers cannot
-- execute the same queued or sleeping run.
WITH due AS (
    SELECT id
    FROM ai_me_run
    WHERE status IN ('queued', 'waiting', 'running')
      AND (
          status = 'running'
          OR next_wake_at IS NULL
          OR next_wake_at <= now()
      )
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY COALESCE(next_wake_at, created_at), created_at, id
    LIMIT sqlc.arg('limit')
    FOR UPDATE SKIP LOCKED
)
UPDATE ai_me_run run SET
    lease_owner = sqlc.arg('lease_owner')::text,
    lease_expires_at = now() + make_interval(secs => sqlc.arg('lease_seconds')::int),
    updated_at = now()
FROM due
WHERE run.id = due.id
RETURNING run.*;

-- name: RenewAIMeRunLease :one
UPDATE ai_me_run SET
    lease_expires_at = now() + make_interval(secs => sqlc.arg('lease_seconds')::int),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND lease_owner = sqlc.arg('lease_owner')::text
  AND lease_expires_at > now()
  AND status = 'running'
RETURNING *;

-- name: StartAIMeRun :one
UPDATE ai_me_run SET
    status = 'running',
    started_at = COALESCE(started_at, now()),
    next_wake_at = NULL,
    last_error = '',
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND lease_owner = sqlc.arg('lease_owner')::text
  AND lease_expires_at > now()
  AND status IN ('queued', 'waiting', 'running')
RETURNING *;

-- name: StartSpecificAIMeRun :one
-- Synchronous entry points lease the exact run they just created instead of
-- claiming unrelated queued work owned by the background worker.
UPDATE ai_me_run SET
    status = 'running',
    lease_owner = sqlc.arg('lease_owner')::text,
    lease_expires_at = now() + make_interval(secs => sqlc.arg('lease_seconds')::int),
    started_at = COALESCE(started_at, now()),
    next_wake_at = NULL,
    last_error = '',
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'queued'
  AND (lease_expires_at IS NULL OR lease_expires_at <= now())
RETURNING *;

-- name: UpdateAIMeRunProgress :one
-- Usage values are absolute totals so retrying the update cannot double-count
-- tokens or cost.
UPDATE ai_me_run SET
    provider = sqlc.arg('provider')::text,
    model = sqlc.arg('model')::text,
    step_count = sqlc.arg('step_count')::int,
    input_tokens = sqlc.arg('input_tokens')::bigint,
    output_tokens = sqlc.arg('output_tokens')::bigint,
    cache_read_tokens = sqlc.arg('cache_read_tokens')::bigint,
    cost_microusd = sqlc.arg('cost_microusd')::bigint,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND lease_owner = sqlc.arg('lease_owner')::text
  AND lease_expires_at > now()
  AND status = 'running'
RETURNING *;

-- name: WaitAIMeRun :one
UPDATE ai_me_run SET
    status = sqlc.arg('status')::text,
    next_wake_at = sqlc.narg('next_wake_at')::timestamptz,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND lease_owner = sqlc.arg('lease_owner')::text
  AND status = 'running'
  AND sqlc.arg('status')::text IN ('waiting', 'waiting_approval')
RETURNING *;

-- name: WaitAIMeRunForToolApproval :one
UPDATE ai_me_run run SET
    status = 'waiting_approval',
    next_wake_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
FROM ai_me_tool_call call
WHERE call.id = sqlc.arg('tool_call_id')::uuid
  AND call.run_id = run.id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND run.status = 'running'
RETURNING run.*;

-- name: UpdateWaitingAIMeRunProgress :one
UPDATE ai_me_run SET
    provider = sqlc.arg('provider')::text,
    model = sqlc.arg('model')::text,
    step_count = sqlc.arg('step_count')::int,
    input_tokens = sqlc.arg('input_tokens')::bigint,
    output_tokens = sqlc.arg('output_tokens')::bigint,
    cache_read_tokens = sqlc.arg('cache_read_tokens')::bigint,
    cost_microusd = sqlc.arg('cost_microusd')::bigint,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'waiting_approval'
RETURNING *;

-- name: RecoverAIMeRunFromTerminalToolCalls :one
WITH tool_state AS (
    SELECT
        run_id,
        bool_and(status IN ('succeeded', 'failed', 'rejected', 'cancelled')) AS all_terminal,
        bool_or(status = 'failed') AS any_failed,
        bool_or(status = 'rejected') AS any_rejected,
        bool_or(status = 'cancelled') AS any_cancelled
    FROM ai_me_tool_call
    WHERE run_id = sqlc.arg('id')::uuid
    GROUP BY run_id
)
UPDATE ai_me_run run SET
    status = CASE
        WHEN tool_state.any_failed THEN 'failed'
        WHEN tool_state.any_rejected THEN 'rejected'
        WHEN tool_state.any_cancelled THEN 'cancelled'
        ELSE 'succeeded'
    END,
    final_output = jsonb_build_object(
        'summary', CASE WHEN tool_state.any_failed THEN 'AI-Me 工具调用执行失败。' ELSE 'AI-Me 已恢复完成的工具调用。' END,
        'risk_level', 'medium',
        'confidence', 1,
        'need_approval', false,
        'reply_draft', '',
        'reasoning_summary', '根据持久化 Tool Call 状态恢复。',
        'actions', '[]'::jsonb,
        'evidence', '[]'::jsonb
    ),
    last_error = CASE WHEN tool_state.any_failed THEN 'recovered failed tool call' ELSE '' END,
    completed_at = now(),
    next_wake_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
FROM tool_state
WHERE run.id = tool_state.run_id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND run.status = 'running'
  AND tool_state.all_terminal
RETURNING run.*;

-- name: ResumeAIMeRunAfterApproval :one
UPDATE ai_me_run SET
    status = 'queued',
    next_wake_at = now(),
    last_error = '',
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'waiting_approval'
RETURNING *;

-- name: CompleteAIMeRun :one
UPDATE ai_me_run SET
    status = 'succeeded',
    final_output = sqlc.arg('final_output')::jsonb,
    last_error = '',
    completed_at = now(),
    next_wake_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND lease_owner = sqlc.arg('lease_owner')::text
  AND status = 'running'
RETURNING *;

-- name: FailAIMeRun :one
UPDATE ai_me_run SET
    status = 'failed',
    last_error = sqlc.arg('last_error')::text,
    completed_at = now(),
    next_wake_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND lease_owner = sqlc.arg('lease_owner')::text
  AND status = 'running'
RETURNING *;

-- name: CancelAIMeRun :one
UPDATE ai_me_run SET
    status = 'cancelled',
    last_error = COALESCE(sqlc.narg('last_error')::text, last_error),
    completed_at = now(),
    next_wake_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status IN ('queued', 'running', 'waiting', 'waiting_approval')
RETURNING *;

-- name: CreateAIMeToolCall :one
-- Tool calls use a run-scoped idempotency key because provider call IDs are
-- not guaranteed to remain stable when a model request is retried.
INSERT INTO ai_me_tool_call (
    run_id,
    provider_call_id,
    tool_name,
    arguments,
    risk_level,
    approval_behavior,
    idempotency_key
)
SELECT
    sqlc.arg('run_id')::uuid,
    sqlc.arg('provider_call_id')::text,
    sqlc.arg('tool_name')::text,
    sqlc.arg('arguments')::jsonb,
    sqlc.arg('risk_level')::text,
    sqlc.arg('approval_behavior')::text,
    sqlc.arg('idempotency_key')::text
FROM ai_me_run
WHERE id = sqlc.arg('run_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
ON CONFLICT (run_id, idempotency_key)
DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
RETURNING *;

-- name: GetAIMeToolCall :one
SELECT call.*
FROM ai_me_tool_call call
JOIN ai_me_run run ON run.id = call.run_id
WHERE call.id = sqlc.arg('id')::uuid
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: FindAIMeToolCallByIdempotencyKey :one
SELECT call.*
FROM ai_me_tool_call call
JOIN ai_me_run run ON run.id = call.run_id
WHERE call.run_id = sqlc.arg('run_id')::uuid
  AND call.idempotency_key = sqlc.arg('idempotency_key')::text
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListAIMeToolCalls :many
SELECT call.*
FROM ai_me_tool_call call
JOIN ai_me_run run ON run.id = call.run_id
WHERE call.run_id = sqlc.arg('run_id')::uuid
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY call.created_at, call.id;

-- name: StartAIMeToolCall :one
UPDATE ai_me_tool_call call SET
    status = 'running',
    started_at = COALESCE(call.started_at, now()),
    error = '',
    updated_at = now()
FROM ai_me_run run
WHERE call.id = sqlc.arg('id')::uuid
  AND call.run_id = run.id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND call.status = 'pending'
RETURNING call.*;

-- name: WaitAIMeToolCallForApproval :one
UPDATE ai_me_tool_call call SET
    status = 'waiting_approval',
    updated_at = now()
FROM ai_me_run run
WHERE call.id = sqlc.arg('id')::uuid
  AND call.run_id = run.id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND call.status = 'pending'
RETURNING call.*;

-- name: ResumeAIMeToolCallAfterApproval :one
UPDATE ai_me_tool_call call SET
    status = 'pending',
    error = '',
    updated_at = now()
FROM ai_me_run run
WHERE call.id = sqlc.arg('id')::uuid
  AND call.run_id = run.id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND call.status = 'waiting_approval'
RETURNING call.*;

-- name: CompleteAIMeToolCall :one
UPDATE ai_me_tool_call call SET
    status = 'succeeded',
    result = sqlc.arg('result')::jsonb,
    error = '',
    created_issue_id = sqlc.narg('created_issue_id')::uuid,
    created_task_id = sqlc.narg('created_task_id')::uuid,
    created_comment_id = sqlc.narg('created_comment_id')::uuid,
    completed_at = now(),
    updated_at = now()
FROM ai_me_run run
WHERE call.id = sqlc.arg('id')::uuid
  AND call.run_id = run.id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND call.status = 'running'
RETURNING call.*;

-- name: FailAIMeToolCall :one
UPDATE ai_me_tool_call call SET
    status = 'failed',
    error = sqlc.arg('error')::text,
    completed_at = now(),
    updated_at = now()
FROM ai_me_run run
WHERE call.id = sqlc.arg('id')::uuid
  AND call.run_id = run.id
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
  AND call.status IN ('pending', 'waiting_approval', 'running')
RETURNING call.*;

-- name: FinishAIMeToolCallAfterApproval :one
-- Approval execution is the terminal step for the v0.1 create/assign tools;
-- the resulting Issue becomes the source of truth for subsequent worker work.
WITH finished_call AS (
    UPDATE ai_me_tool_call call SET
        status = sqlc.arg('outcome')::text,
        result = sqlc.arg('result')::jsonb,
        error = sqlc.arg('error')::text,
        created_issue_id = sqlc.narg('created_issue_id')::uuid,
        created_task_id = sqlc.narg('created_task_id')::uuid,
        created_comment_id = sqlc.narg('created_comment_id')::uuid,
        completed_at = now(),
        updated_at = now()
    FROM ai_me_run run
    WHERE call.id = sqlc.arg('tool_call_id')::uuid
      AND call.run_id = run.id
      AND run.workspace_id = sqlc.arg('workspace_id')::uuid
      AND call.status IN ('waiting_approval', 'failed')
      AND sqlc.arg('outcome')::text IN ('succeeded', 'failed', 'rejected', 'cancelled')
    RETURNING call.*
)
UPDATE ai_me_run run SET
    status = sqlc.arg('outcome')::text,
    final_output = sqlc.arg('result')::jsonb,
    last_error = sqlc.arg('error')::text,
    completed_at = now(),
    next_wake_at = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
FROM finished_call call
WHERE run.id = call.run_id
RETURNING call.id AS tool_call_id, run.*;

-- name: LinkAIMeApprovalToolCall :one
UPDATE ai_me_approval approval SET
    tool_call_id = sqlc.arg('tool_call_id')::uuid,
    updated_at = now()
FROM ai_me_tool_call call
JOIN ai_me_run run ON run.id = call.run_id
WHERE approval.id = sqlc.arg('approval_id')::uuid
  AND approval.workspace_id = sqlc.arg('workspace_id')::uuid
  AND call.id = sqlc.arg('tool_call_id')::uuid
  AND run.workspace_id = approval.workspace_id
RETURNING approval.*;

-- name: AppendAIMeRunStep :one
-- A repeated sequence is a retry of the same append operation; the original
-- durable step wins and is returned unchanged.
INSERT INTO ai_me_run_step (
    run_id,
    sequence,
    step_type,
    message,
    tool_call_id,
    provider,
    model,
    usage,
    cost_microusd,
    duration_ms
)
SELECT
    sqlc.arg('run_id')::uuid,
    sqlc.arg('sequence')::int,
    sqlc.arg('step_type')::text,
    sqlc.arg('message')::jsonb,
    sqlc.narg('tool_call_id')::uuid,
    sqlc.arg('provider')::text,
    sqlc.arg('model')::text,
    sqlc.arg('usage')::jsonb,
    sqlc.arg('cost_microusd')::bigint,
    sqlc.arg('duration_ms')::bigint
FROM ai_me_run
WHERE id = sqlc.arg('run_id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
ON CONFLICT (run_id, sequence)
DO UPDATE SET sequence = EXCLUDED.sequence
RETURNING *;

-- name: GetAIMeRunStep :one
SELECT step.*
FROM ai_me_run_step step
JOIN ai_me_run run ON run.id = step.run_id
WHERE step.run_id = sqlc.arg('run_id')::uuid
  AND step.sequence = sqlc.arg('sequence')::int
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListAIMeRunSteps :many
SELECT step.*
FROM ai_me_run_step step
JOIN ai_me_run run ON run.id = step.run_id
WHERE step.run_id = sqlc.arg('run_id')::uuid
  AND run.workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY step.sequence;
