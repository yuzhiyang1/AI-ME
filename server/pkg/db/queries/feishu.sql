-- name: ListFeishuMessageLogs :many
WITH quality AS (
    SELECT DISTINCT ON (approval_id)
        approval_id,
        CASE
            WHEN payload->>'score' ~ '^[1-5]$' THEN (payload->>'score')::int
            ELSE 0
        END AS quality_score,
        COALESCE(payload->>'note', '')::text AS quality_note,
        created_at AS quality_scored_at
    FROM ai_me_approval_event
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND event_type = 'edited'
      AND payload->>'kind' = 'quality_review'
    ORDER BY approval_id, created_at DESC, id DESC
)
SELECT
    i.id AS inbox_item_id,
    i.workspace_id,
    i.recipient_id,
    i.title AS inbox_title,
    COALESCE(i.body, '')::text AS inbound_text,
    i.read,
    i.archived,
    i.created_at AS received_at,
    COALESCE(i.details->>'message_id', '')::text AS message_id,
    COALESCE(i.details->>'event_id', '')::text AS event_id,
    COALESCE(i.details->>'chat_id', '')::text AS chat_id,
    COALESCE(i.details->>'chat_type', '')::text AS chat_type,
    COALESCE(i.details->>'sender_open_id', '')::text AS sender_open_id,
    COALESCE(i.details->>'sender_user_id', '')::text AS sender_user_id,
    COALESCE(i.details->>'sender_union_id', '')::text AS sender_union_id,
    COALESCE(i.details->>'gate_reason', '')::text AS gate_reason,
    COALESCE(i.details->>'approval_id', '')::text AS approval_id,
    COALESCE(a.status, '')::text AS approval_status,
    COALESCE(a.risk_level, '')::text AS risk_level,
    COALESCE(a.execution_status, '')::text AS execution_status,
    COALESCE(a.execution_error, '')::text AS execution_error,
    a.approved_at,
    a.executed_at,
    COALESCE(a.final_payload->>'text', '')::text AS reply_text,
    COALESCE(a.final_payload->>'draft_source', '')::text AS draft_source,
    COALESCE(a.final_payload->>'draft_provider', '')::text AS draft_provider,
    COALESCE(a.final_payload->>'draft_model', '')::text AS draft_model,
    (CASE WHEN a.final_payload#>>'{draft_usage,input_tokens}' ~ '^\d+$' THEN (a.final_payload#>>'{draft_usage,input_tokens}')::bigint ELSE 0 END)::bigint AS draft_input_tokens,
    (CASE WHEN a.final_payload#>>'{draft_usage,output_tokens}' ~ '^\d+$' THEN (a.final_payload#>>'{draft_usage,output_tokens}')::bigint ELSE 0 END)::bigint AS draft_output_tokens,
    (CASE WHEN a.final_payload#>>'{draft_usage,cache_read_tokens}' ~ '^\d+$' THEN (a.final_payload#>>'{draft_usage,cache_read_tokens}')::bigint ELSE 0 END)::bigint AS draft_cache_read_tokens,
    (CASE WHEN a.final_payload#>>'{draft_usage,cost_microusd}' ~ '^\d+$' THEN (a.final_payload#>>'{draft_usage,cost_microusd}')::bigint ELSE 0 END)::bigint AS draft_cost_microusd,
    COALESCE(q.quality_score, 0)::int AS quality_score,
    COALESCE(q.quality_note, '')::text AS quality_note,
    q.quality_scored_at
FROM inbox_item i
LEFT JOIN ai_me_approval a
  ON a.workspace_id = i.workspace_id
 AND a.id::text = i.details->>'approval_id'
LEFT JOIN quality q
  ON q.approval_id = a.id
WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid
  AND i.details->>'source_type' = 'feishu'
ORDER BY i.created_at DESC, i.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: FindFeishuWebhookEventByKey :one
SELECT *
FROM ai_me_feishu_webhook_event
WHERE event_key = sqlc.arg('event_key')::text;

-- name: CreateFeishuWebhookEvent :one
INSERT INTO ai_me_feishu_webhook_event (
    workspace_id,
    event_key,
    event_id,
    message_id,
    event_type,
    status,
    reason,
    signature_verified,
    token_verified,
    replay_protected,
    request_timestamp,
    raw_body_sha256
) VALUES (
    sqlc.narg('workspace_id')::uuid,
    sqlc.arg('event_key')::text,
    sqlc.arg('event_id')::text,
    sqlc.arg('message_id')::text,
    sqlc.arg('event_type')::text,
    sqlc.arg('status')::text,
    sqlc.arg('reason')::text,
    sqlc.arg('signature_verified')::boolean,
    sqlc.arg('token_verified')::boolean,
    sqlc.arg('replay_protected')::boolean,
    sqlc.narg('request_timestamp')::timestamptz,
    sqlc.arg('raw_body_sha256')::text
)
RETURNING *;

-- name: MarkFeishuWebhookEventDuplicate :one
UPDATE ai_me_feishu_webhook_event SET
    duplicate_count = duplicate_count + 1,
    updated_at = now()
WHERE event_key = sqlc.arg('event_key')::text
RETURNING *;

-- name: UpdateFeishuWebhookEventStatus :one
UPDATE ai_me_feishu_webhook_event SET
    workspace_id = COALESCE(sqlc.narg('workspace_id')::uuid, workspace_id),
    status = sqlc.arg('status')::text,
    reason = COALESCE(sqlc.narg('reason')::text, reason),
    inbox_item_id = COALESCE(sqlc.narg('inbox_item_id')::uuid, inbox_item_id),
    approval_id = COALESCE(sqlc.narg('approval_id')::uuid, approval_id),
    updated_at = now()
WHERE event_key = sqlc.arg('event_key')::text
RETURNING *;

-- name: GetFeishuReliabilitySummary :one
SELECT
    count(*)::bigint AS webhook_events,
    COALESCE(sum(duplicate_count), 0)::bigint AS duplicate_events,
    count(*) FILTER (WHERE status = 'accepted')::bigint AS accepted_events,
    count(*) FILTER (WHERE status = 'ignored')::bigint AS ignored_events,
    count(*) FILTER (WHERE status = 'failed')::bigint AS failed_events,
    count(*) FILTER (WHERE status = 'rejected')::bigint AS rejected_events,
    count(*) FILTER (WHERE signature_verified)::bigint AS signature_verified_events,
    count(*) FILTER (WHERE replay_protected)::bigint AS replay_protected_events,
    count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::bigint AS events_today,
    max(updated_at)::timestamptz AS last_event_at
FROM ai_me_feishu_webhook_event
WHERE workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListFeishuWebhookEvents :many
SELECT *
FROM ai_me_feishu_webhook_event
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: UpsertFeishuDeliverySending :one
INSERT INTO ai_me_feishu_delivery (
    workspace_id,
    approval_id,
    source_message_id,
    status,
    attempt_count,
    last_error,
    next_retry_at
) VALUES (
    sqlc.arg('workspace_id')::uuid,
    sqlc.arg('approval_id')::uuid,
    sqlc.arg('source_message_id')::text,
    'sending',
    1,
    '',
    NULL
)
ON CONFLICT (approval_id) WHERE approval_id IS NOT NULL
DO UPDATE SET
    status = 'sending',
    source_message_id = EXCLUDED.source_message_id,
    attempt_count = ai_me_feishu_delivery.attempt_count + 1,
    last_error = '',
    next_retry_at = NULL,
    updated_at = now()
RETURNING *;

-- name: MarkFeishuDeliverySucceeded :one
UPDATE ai_me_feishu_delivery SET
    status = 'succeeded',
    reply_message_id = COALESCE(sqlc.narg('reply_message_id')::text, reply_message_id),
    last_error = '',
    next_retry_at = NULL,
    sent_at = now(),
    updated_at = now()
WHERE approval_id = sqlc.arg('approval_id')::uuid
RETURNING *;

-- name: MarkFeishuDeliveryFailed :one
UPDATE ai_me_feishu_delivery SET
    status = CASE WHEN attempt_count >= sqlc.arg('max_attempts')::int THEN 'dead_letter' ELSE 'failed' END,
    last_error = sqlc.arg('last_error')::text,
    next_retry_at = CASE
        WHEN attempt_count >= sqlc.arg('max_attempts')::int THEN NULL
        ELSE now() + make_interval(secs => sqlc.arg('retry_after_seconds')::int)
    END,
    updated_at = now()
WHERE approval_id = sqlc.arg('approval_id')::uuid
RETURNING *;

-- name: GetFeishuDeliverySummary :one
SELECT
    count(*)::bigint AS deliveries,
    count(*) FILTER (WHERE status = 'sending')::bigint AS sending,
    count(*) FILTER (WHERE status = 'succeeded')::bigint AS succeeded,
    count(*) FILTER (WHERE status = 'failed')::bigint AS failed,
    count(*) FILTER (WHERE status = 'dead_letter')::bigint AS dead_letter,
    COALESCE(sum(attempt_count), 0)::bigint AS attempts,
    max(updated_at)::timestamptz AS last_delivery_at
FROM ai_me_feishu_delivery
WHERE workspace_id = sqlc.arg('workspace_id')::uuid;

-- name: ListFeishuDeliveries :many
SELECT *
FROM ai_me_feishu_delivery
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: ClaimDueFeishuDeliveries :many
WITH due AS (
    SELECT d.id
    FROM ai_me_feishu_delivery d
    JOIN ai_me_approval a ON a.id = d.approval_id
    WHERE (
        (d.status = 'failed' AND d.next_retry_at <= now())
        OR (
            d.status = 'sending'
            AND d.updated_at <= now() - make_interval(secs => sqlc.arg('stale_after_seconds')::int)
        )
      )
      AND a.status = 'approved'
      AND a.execution_status = 'failed'
      AND a.action_type = 'send_external_message'
      AND a.source_type = 'feishu'
    ORDER BY d.next_retry_at ASC, d.id ASC
    FOR UPDATE OF d SKIP LOCKED
    LIMIT sqlc.arg('limit')
)
UPDATE ai_me_feishu_delivery d SET
    status = 'sending',
    next_retry_at = NULL,
    updated_at = now()
FROM due
WHERE d.id = due.id
RETURNING d.*;

-- name: ReleaseClaimedFeishuDelivery :one
UPDATE ai_me_feishu_delivery SET
    status = 'failed',
    last_error = sqlc.arg('last_error')::text,
    next_retry_at = now() + make_interval(secs => sqlc.arg('retry_after_seconds')::int),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND status = 'sending'
RETURNING *;

-- name: GetAIApprovalQualitySummary :one
WITH latest_quality AS (
    SELECT DISTINCT ON (approval_id)
        approval_id,
        CASE
            WHEN payload->>'score' ~ '^[1-5]$' THEN (payload->>'score')::int
            ELSE 0
        END AS score,
        COALESCE(payload->>'outcome', '')::text AS outcome,
        created_at
    FROM ai_me_approval_event
    WHERE workspace_id = sqlc.arg('workspace_id')::uuid
      AND event_type = 'edited'
      AND payload->>'kind' = 'quality_review'
    ORDER BY approval_id, created_at DESC, id DESC
)
SELECT
    count(*)::bigint AS reviewed,
    COALESCE(avg(NULLIF(score, 0)), 0)::float8 AS avg_score,
    count(*) FILTER (WHERE score >= 4)::bigint AS good,
    count(*) FILTER (WHERE score BETWEEN 1 AND 2)::bigint AS poor,
    count(*) FILTER (WHERE outcome = 'accepted')::bigint AS accepted,
    count(*) FILTER (WHERE outcome = 'needs_retry')::bigint AS needs_retry,
    count(*) FILTER (WHERE outcome = 'wrong')::bigint AS wrong,
    max(created_at)::timestamptz AS last_reviewed_at
FROM latest_quality;

-- name: GetFeishuDogfoodSummary :one
WITH base AS (
    SELECT
        i.id AS inbox_item_id,
        i.created_at AS received_at,
        a.id AS approval_id,
        a.status AS approval_status,
        a.execution_status,
        a.final_payload,
        CASE
            WHEN COALESCE(a.final_payload->>'draft_source', '') <> 'ai_model' THEN 0
            WHEN a.final_payload#>>'{draft_usage,cost_microusd}' ~ '^\d+$'
                THEN (a.final_payload#>>'{draft_usage,cost_microusd}')::bigint
            ELSE sqlc.arg('draft_cost_cents')::bigint * 10000
        END AS draft_cost_microusd,
        q.quality_score
    FROM inbox_item i
    LEFT JOIN ai_me_approval a
      ON a.workspace_id = i.workspace_id
     AND a.id::text = i.details->>'approval_id'
    LEFT JOIN LATERAL (
        SELECT
            CASE
                WHEN e.payload->>'score' ~ '^[1-5]$' THEN (e.payload->>'score')::int
                ELSE 0
            END AS quality_score
        FROM ai_me_approval_event e
        WHERE e.workspace_id = i.workspace_id
          AND a.id IS NOT NULL
          AND e.approval_id = a.id
          AND e.event_type = 'edited'
          AND e.payload->>'kind' = 'quality_review'
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
    ) q ON true
    WHERE i.workspace_id = sqlc.arg('workspace_id')::uuid
      AND i.details->>'source_type' = 'feishu'
)
SELECT
    count(*)::bigint AS total_received,
    count(*) FILTER (WHERE received_at >= date_trunc('day', now()))::bigint AS received_today,
    count(*) FILTER (WHERE approval_id IS NOT NULL)::bigint AS approvals_created,
    count(*) FILTER (WHERE approval_status = 'pending')::bigint AS pending_approval,
    count(*) FILTER (WHERE approval_status = 'rejected')::bigint AS rejected,
    count(*) FILTER (WHERE execution_status = 'succeeded')::bigint AS sent,
    count(*) FILTER (WHERE execution_status = 'failed')::bigint AS send_failed,
    count(*) FILTER (WHERE final_payload->>'draft_source' = 'ai_model')::bigint AS ai_drafted,
    count(*) FILTER (
        WHERE received_at >= date_trunc('day', now())
          AND final_payload->>'draft_source' = 'ai_model'
    )::bigint AS draft_call_count_today,
    count(*) FILTER (WHERE quality_score > 0)::bigint AS quality_reviewed,
    COALESCE(avg(NULLIF(quality_score, 0)), 0)::float8 AS avg_quality_score,
    LEAST(count(*) FILTER (
        WHERE quality_score > 0
          AND (execution_status = 'succeeded' OR approval_status = 'rejected')
    ), 20)::bigint AS dogfood_completed,
    GREATEST(20 - count(*) FILTER (
        WHERE quality_score > 0
          AND (execution_status = 'succeeded' OR approval_status = 'rejected')
    ), 0)::bigint AS dogfood_remaining,
    min(received_at)::timestamptz AS first_received_at,
    max(received_at)::timestamptz AS last_received_at,
    COALESCE(sum(draft_cost_microusd) FILTER (WHERE received_at >= date_trunc('day', now())), 0)::bigint AS draft_cost_microusd,
    CEIL(COALESCE(sum(draft_cost_microusd) FILTER (WHERE received_at >= date_trunc('day', now())), 0)::numeric / 10000)::bigint AS estimated_draft_cost_cents
FROM base;

-- name: GetAIMeWorkerUsageSummary :one
SELECT
    COALESCE(SUM(tu.input_tokens), 0)::bigint AS input_tokens,
    COALESCE(SUM(tu.output_tokens), 0)::bigint AS output_tokens,
    COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS cache_read_tokens,
    COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS cache_write_tokens,
    COUNT(DISTINCT tu.task_id)::bigint AS task_count
FROM task_usage tu
JOIN agent_task_queue atq ON atq.id = tu.task_id
JOIN agent a ON a.id = atq.agent_id
WHERE a.workspace_id = sqlc.arg('workspace_id')::uuid
  AND tu.created_at >= date_trunc('day', now());

-- name: GetAIMeOnboardingCounts :one
SELECT
    (SELECT count(*) FROM agent WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND archived_at IS NULL)::bigint AS agent_count,
    (SELECT count(*) FROM ai_me_approval WHERE workspace_id = sqlc.arg('workspace_id')::uuid)::bigint AS approval_count,
    (SELECT count(*) FROM ai_me_approval WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND execution_status = 'succeeded')::bigint AS execution_succeeded_count,
    (SELECT count(*) FROM inbox_item WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND details->>'source_type' = 'feishu')::bigint AS feishu_message_count,
    (SELECT count(*) FROM ai_me_approval WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND source_type = 'feishu')::bigint AS feishu_approval_count,
    (SELECT count(*) FROM ai_me_approval WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND source_type = 'feishu' AND execution_status = 'succeeded')::bigint AS feishu_sent_count,
    (
        SELECT count(*)
        FROM ai_me_approval_event e
        JOIN ai_me_approval a ON a.id = e.approval_id
        WHERE e.workspace_id = sqlc.arg('workspace_id')::uuid
          AND a.source_type = 'feishu'
          AND e.event_type = 'edited'
          AND e.payload->>'kind' = 'quality_review'
    )::bigint AS feishu_quality_review_count,
    (SELECT count(*) FROM memory_entry WHERE workspace_id = sqlc.arg('workspace_id')::uuid AND status = 'active' AND archived_at IS NULL)::bigint AS active_memory_count;
