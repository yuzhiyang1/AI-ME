-- name: ListMemoryEntries :many
SELECT *
FROM memory_entry
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('type')::text IS NULL OR type = sqlc.narg('type')::text)
  AND (sqlc.narg('category')::text IS NULL OR category = sqlc.narg('category')::text)
  AND (
    sqlc.narg('query')::text IS NULL
    OR title ILIKE '%' || sqlc.narg('query')::text || '%'
    OR content ILIKE '%' || sqlc.narg('query')::text || '%'
    OR summary ILIKE '%' || sqlc.narg('query')::text || '%'
  )
ORDER BY updated_at DESC, created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountMemoryEntries :one
SELECT count(*)::bigint
FROM memory_entry
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('type')::text IS NULL OR type = sqlc.narg('type')::text)
  AND (sqlc.narg('category')::text IS NULL OR category = sqlc.narg('category')::text)
  AND (
    sqlc.narg('query')::text IS NULL
    OR title ILIKE '%' || sqlc.narg('query')::text || '%'
    OR content ILIKE '%' || sqlc.narg('query')::text || '%'
    OR summary ILIKE '%' || sqlc.narg('query')::text || '%'
  );

-- name: GetMemoryEntryInWorkspace :one
SELECT *
FROM memory_entry
WHERE id = $1 AND workspace_id = $2;

-- name: CreateMemoryEntry :one
INSERT INTO memory_entry (
    workspace_id,
    owner_user_id,
    project_id,
    type,
    category,
    title,
    content,
    summary,
    status,
    confidence,
    sensitivity,
    scope_type,
    scope_ref_id,
    external_use_policy,
    source_mode,
    created_by_type,
    created_by_id,
    expires_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18
)
RETURNING *;

-- name: UpdateMemoryEntry :one
UPDATE memory_entry SET
    owner_user_id = COALESCE(sqlc.narg('owner_user_id'), owner_user_id),
    project_id = COALESCE(sqlc.narg('project_id'), project_id),
    type = COALESCE(sqlc.narg('type'), type),
    category = COALESCE(sqlc.narg('category'), category),
    title = COALESCE(sqlc.narg('title'), title),
    content = COALESCE(sqlc.narg('content'), content),
    summary = COALESCE(sqlc.narg('summary'), summary),
    status = COALESCE(sqlc.narg('status'), status),
    confidence = COALESCE(sqlc.narg('confidence'), confidence),
    sensitivity = COALESCE(sqlc.narg('sensitivity'), sensitivity),
    scope_type = COALESCE(sqlc.narg('scope_type'), scope_type),
    scope_ref_id = COALESCE(sqlc.narg('scope_ref_id'), scope_ref_id),
    external_use_policy = COALESCE(sqlc.narg('external_use_policy'), external_use_policy),
    expires_at = COALESCE(sqlc.narg('expires_at'), expires_at),
    archived_at = CASE
        WHEN sqlc.narg('status')::text = 'archived' THEN COALESCE(archived_at, now())
        WHEN sqlc.narg('status')::text IS NOT NULL AND sqlc.narg('status')::text <> 'archived' THEN NULL
        ELSE archived_at
    END,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: ConfirmMemoryEntry :one
UPDATE memory_entry SET
    status = 'active',
    verified_by = sqlc.arg('verified_by')::uuid,
    verified_at = now(),
    archived_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'candidate'
RETURNING *;

-- name: RejectMemoryEntry :one
UPDATE memory_entry SET
    status = 'rejected',
    archived_at = NULL,
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
  AND status = 'candidate'
RETURNING *;

-- name: ArchiveMemoryEntry :one
UPDATE memory_entry SET
    status = 'archived',
    archived_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: VerifyMemoryEntry :one
UPDATE memory_entry SET
    verified_by = sqlc.arg('verified_by')::uuid,
    verified_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id')::uuid
  AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;

-- name: CreateMemorySource :one
INSERT INTO memory_source (
    workspace_id,
    source_type,
    source_ref_id,
    source_url,
    title,
    excerpt,
    metadata,
    captured_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
)
RETURNING *;

-- name: ListMemorySources :many
SELECT *
FROM memory_source
WHERE workspace_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListMemoryEvidence :many
SELECT
    e.id,
    e.memory_id,
    e.source_id,
    e.excerpt,
    e.location,
    e.confidence,
    e.created_at,
    s.workspace_id,
    s.source_type,
    s.source_ref_id,
    s.source_url,
    s.title AS source_title,
    s.excerpt AS source_excerpt,
    s.metadata AS source_metadata,
    s.captured_at AS source_captured_at,
    s.created_at AS source_created_at
FROM memory_evidence e
JOIN memory_source s ON s.id = e.source_id
WHERE e.memory_id = $1
ORDER BY e.created_at ASC, e.id ASC;

-- name: CreateMemoryEvidence :one
INSERT INTO memory_evidence (
    memory_id,
    source_id,
    excerpt,
    location,
    confidence
) VALUES (
    $1, $2, $3, $4, $5
)
RETURNING *;

-- name: ListMemoryUsage :many
SELECT *
FROM memory_usage
WHERE memory_id = $1
ORDER BY created_at DESC
LIMIT $2;

-- name: CreateMemoryUsage :one
INSERT INTO memory_usage (
    workspace_id,
    memory_id,
    used_by_type,
    used_by_id,
    issue_id,
    task_queue_id,
    chat_session_id,
    action,
    outcome
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
)
RETURNING *;

-- name: ListKnowledgeDocuments :many
SELECT *
FROM knowledge_document
WHERE workspace_id = sqlc.arg('workspace_id')::uuid
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
ORDER BY updated_at DESC, created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CreateKnowledgeDocument :one
INSERT INTO knowledge_document (
    workspace_id,
    title,
    source_type,
    source_url,
    attachment_id,
    status,
    imported_by,
    metadata
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
)
RETURNING *;

-- name: UpdateKnowledgeDocumentStatus :one
UPDATE knowledge_document SET
    status = $3,
    last_indexed_at = CASE WHEN $3 = 'ready' THEN now() ELSE last_indexed_at END,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;
