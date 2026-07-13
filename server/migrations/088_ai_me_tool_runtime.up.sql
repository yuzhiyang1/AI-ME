CREATE TABLE ai_me_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id UUID REFERENCES "user"(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued',
        'running',
        'waiting',
        'waiting_approval',
        'succeeded',
        'failed',
        'cancelled'
    )),
    input JSONB NOT NULL DEFAULT '{}',
    context_snapshot JSONB NOT NULL DEFAULT '{}',
    policy_snapshot JSONB NOT NULL DEFAULT '{}',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
    max_steps INTEGER NOT NULL DEFAULT 8 CHECK (max_steps > 0),
    input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
    final_output JSONB NOT NULL DEFAULT '{}',
    last_error TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    next_wake_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source <> ''),
    CHECK (idempotency_key <> ''),
    CHECK (step_count <= max_steps),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE ai_me_tool_call (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ai_me_run(id) ON DELETE CASCADE,
    provider_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'waiting_approval',
        'running',
        'succeeded',
        'failed',
        'cancelled'
    )),
    risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
    approval_behavior TEXT NOT NULL DEFAULT 'auto_execute',
    result JSONB NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_issue_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    created_task_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    created_comment_id UUID REFERENCES comment(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (provider_call_id <> ''),
    CHECK (tool_name <> ''),
    CHECK (approval_behavior <> ''),
    CHECK (idempotency_key <> ''),
    UNIQUE (run_id, provider_call_id),
    UNIQUE (run_id, idempotency_key)
);

CREATE TABLE ai_me_run_step (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ai_me_run(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    step_type TEXT NOT NULL,
    message JSONB NOT NULL DEFAULT '{}',
    tool_call_id UUID REFERENCES ai_me_tool_call(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    usage JSONB NOT NULL DEFAULT '{}',
    cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
    duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (step_type <> ''),
    UNIQUE (run_id, sequence)
);

ALTER TABLE ai_me_approval
    ADD COLUMN tool_call_id UUID REFERENCES ai_me_tool_call(id) ON DELETE SET NULL;

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
    CHECK (origin_type IN ('autopilot', 'quick_create', 'ai_me'));

CREATE UNIQUE INDEX idx_ai_me_run_workspace_idempotency
    ON ai_me_run(workspace_id, idempotency_key);

CREATE INDEX idx_ai_me_run_workspace_status_wake
    ON ai_me_run(workspace_id, status, next_wake_at, created_at);

CREATE INDEX idx_ai_me_run_lease
    ON ai_me_run(lease_expires_at)
    WHERE lease_expires_at IS NOT NULL;

CREATE INDEX idx_ai_me_run_user_created
    ON ai_me_run(workspace_id, user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX idx_ai_me_tool_call_run_created
    ON ai_me_tool_call(run_id, created_at, id);

CREATE UNIQUE INDEX idx_ai_me_approval_tool_call
    ON ai_me_approval(tool_call_id)
    WHERE tool_call_id IS NOT NULL;
