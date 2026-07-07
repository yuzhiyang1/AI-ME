-- name: GetAIMeCockpitSummary :one
WITH task_counts AS (
    SELECT
        count(*) FILTER (WHERE atq.status IN ('queued', 'dispatched', 'running'))::bigint AS active_tasks,
        count(*) FILTER (WHERE atq.status = 'queued')::bigint AS queued_tasks,
        count(*) FILTER (WHERE atq.status IN ('dispatched', 'running'))::bigint AS running_tasks,
        count(*) FILTER (
            WHERE atq.status = 'completed'
              AND atq.completed_at >= date_trunc('day', now())
        )::bigint AS completed_tasks_today,
        count(*) FILTER (
            WHERE atq.status = 'failed'
              AND atq.completed_at >= date_trunc('day', now())
        )::bigint AS failed_tasks_today
    FROM agent_task_queue atq
    JOIN agent a ON a.id = atq.agent_id
    WHERE a.workspace_id = sqlc.arg('workspace_id')::uuid
),
approval_counts AS (
    SELECT
        count(*) FILTER (WHERE status = 'pending')::bigint AS pending_decisions,
        count(*) FILTER (WHERE status = 'pending' AND risk_level = 'high')::bigint AS high_risk_pending,
        count(*) FILTER (WHERE status = 'observing')::bigint AS waiting_external,
        count(*) FILTER (WHERE execution_status = 'succeeded')::bigint AS execution_succeeded,
        count(*) FILTER (WHERE execution_status = 'failed')::bigint AS execution_failed,
        count(*) FILTER (WHERE status = 'pending' AND action_type = 'send_external_message')::bigint AS external_reply_pending,
        count(*) FILTER (
            WHERE action_type = 'assign_worker'
              AND execution_status = 'succeeded'
              AND created_task_id IS NOT NULL
        )::bigint AS assign_worker_succeeded,
        count(*) FILTER (
            WHERE action_type = 'send_external_message'
              AND execution_status = 'succeeded'
        )::bigint AS external_reply_succeeded
    FROM ai_me_approval
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
),
memory_counts AS (
    SELECT
        count(*) FILTER (WHERE status = 'active' AND archived_at IS NULL)::bigint AS active_memories
    FROM memory_entry
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
),
memory_usage_counts AS (
    SELECT
        count(*) FILTER (
            WHERE used_by_type = 'ai_me'
              AND created_at >= date_trunc('day', now())
        )::bigint AS memory_used_today
    FROM memory_usage
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
),
inbox_counts AS (
    SELECT
        count(*) FILTER (WHERE read = false AND archived = false)::bigint AS unread_inbox
    FROM inbox_item
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND recipient_type = 'member'
      AND recipient_id = sqlc.arg('user_id')::uuid
),
issue_counts AS (
    SELECT
        count(*) FILTER (WHERE status NOT IN ('done', 'cancelled'))::bigint AS active_issues
    FROM issue
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
)
SELECT
    task_counts.active_tasks,
    task_counts.queued_tasks,
    task_counts.running_tasks,
    task_counts.completed_tasks_today,
    task_counts.failed_tasks_today,
    approval_counts.pending_decisions,
    approval_counts.high_risk_pending,
    approval_counts.waiting_external,
    approval_counts.execution_succeeded,
    approval_counts.execution_failed,
    approval_counts.external_reply_pending,
    approval_counts.assign_worker_succeeded,
    approval_counts.external_reply_succeeded,
    memory_counts.active_memories,
    memory_usage_counts.memory_used_today,
    inbox_counts.unread_inbox,
    issue_counts.active_issues
FROM task_counts, approval_counts, memory_counts, memory_usage_counts, inbox_counts, issue_counts;
