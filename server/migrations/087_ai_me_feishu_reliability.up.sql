CREATE TABLE ai_me_feishu_webhook_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspace(id) ON DELETE SET NULL,
    event_key TEXT NOT NULL,
    event_id TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
        'received',
        'accepted',
        'duplicate',
        'ignored',
        'failed',
        'rejected'
    )),
    reason TEXT NOT NULL DEFAULT '',
    signature_verified BOOLEAN NOT NULL DEFAULT false,
    token_verified BOOLEAN NOT NULL DEFAULT false,
    replay_protected BOOLEAN NOT NULL DEFAULT false,
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    request_timestamp TIMESTAMPTZ,
    raw_body_sha256 TEXT NOT NULL DEFAULT '',
    inbox_item_id UUID REFERENCES inbox_item(id) ON DELETE SET NULL,
    approval_id UUID REFERENCES ai_me_approval(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (event_key <> '')
);

CREATE TABLE ai_me_feishu_delivery (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    approval_id UUID REFERENCES ai_me_approval(id) ON DELETE CASCADE,
    source_message_id TEXT NOT NULL,
    reply_message_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN (
        'sending',
        'succeeded',
        'failed',
        'dead_letter'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT NOT NULL DEFAULT '',
    next_retry_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_message_id <> '')
);

CREATE UNIQUE INDEX idx_ai_me_feishu_webhook_event_key
    ON ai_me_feishu_webhook_event(event_key);

CREATE INDEX idx_ai_me_feishu_webhook_workspace_created
    ON ai_me_feishu_webhook_event(workspace_id, created_at DESC);

CREATE INDEX idx_ai_me_feishu_webhook_status
    ON ai_me_feishu_webhook_event(workspace_id, status, created_at DESC);

CREATE UNIQUE INDEX idx_ai_me_feishu_delivery_approval
    ON ai_me_feishu_delivery(approval_id)
    WHERE approval_id IS NOT NULL;

CREATE INDEX idx_ai_me_feishu_delivery_workspace_status
    ON ai_me_feishu_delivery(workspace_id, status, updated_at DESC);
