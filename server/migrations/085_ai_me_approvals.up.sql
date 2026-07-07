CREATE TABLE ai_me_approval (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    requester_user_id UUID REFERENCES "user"(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN (
        'ai_me_think',
        'exception',
        'inbox',
        'issue',
        'comment',
        'agent_task',
        'memory',
        'feishu',
        'email',
        'github',
        'manual'
    )),
    source_ref_id TEXT,
    source_url TEXT,
    issue_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    inbox_item_id UUID REFERENCES inbox_item(id) ON DELETE SET NULL,
    task_queue_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    memory_id UUID REFERENCES memory_entry(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'approved',
        'rejected',
        'observing',
        'taken_over',
        'expired'
    )),
    risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high')),
    confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    reversibility TEXT NOT NULL DEFAULT 'partially_reversible' CHECK (reversibility IN (
        'reversible',
        'partially_reversible',
        'irreversible'
    )),
    action_type TEXT NOT NULL CHECK (action_type IN (
        'create_issue',
        'assign_worker',
        'draft_reply',
        'send_external_message',
        'post_internal_comment',
        'confirm_memory',
        'no_action'
    )),
    action_title TEXT NOT NULL DEFAULT '',
    action_description TEXT NOT NULL DEFAULT '',
    original_payload JSONB NOT NULL DEFAULT '{}',
    final_payload JSONB NOT NULL DEFAULT '{}',
    ai_reasoning_summary TEXT NOT NULL DEFAULT '',
    approval_note TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL DEFAULT '',
    approved_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ,
    observed_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    observed_at TIMESTAMPTZ,
    taken_over_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    taken_over_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    execution_status TEXT NOT NULL DEFAULT 'not_started' CHECK (execution_status IN (
        'not_started',
        'running',
        'succeeded',
        'failed',
        'skipped'
    )),
    execution_error TEXT NOT NULL DEFAULT '',
    created_issue_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    created_task_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    created_comment_id UUID REFERENCES comment(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (title <> '')
);

CREATE TABLE ai_me_approval_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_id UUID NOT NULL REFERENCES ai_me_approval(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL CHECK (evidence_type IN (
        'user_input',
        'issue',
        'comment',
        'activity',
        'agent_task',
        'memory',
        'document',
        'feishu',
        'email',
        'github',
        'ci',
        'log'
    )),
    label TEXT NOT NULL,
    ref_id TEXT,
    source_url TEXT,
    quote TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (label <> '')
);

CREATE TABLE ai_me_approval_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_id UUID NOT NULL REFERENCES ai_me_approval(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('member', 'agent', 'system', 'ai_me')),
    actor_id UUID,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'created',
        'edited',
        'approved',
        'rejected',
        'observing',
        'taken_over',
        'execution_started',
        'execution_succeeded',
        'execution_failed',
        'expired'
    )),
    from_status TEXT,
    to_status TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_me_approval_workspace_status ON ai_me_approval(workspace_id, status, created_at DESC);
CREATE INDEX idx_ai_me_approval_workspace_risk ON ai_me_approval(workspace_id, risk_level, status, created_at DESC);
CREATE INDEX idx_ai_me_approval_source ON ai_me_approval(workspace_id, source_type, source_ref_id);
CREATE INDEX idx_ai_me_approval_issue ON ai_me_approval(issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_ai_me_approval_created_issue ON ai_me_approval(created_issue_id) WHERE created_issue_id IS NOT NULL;
CREATE INDEX idx_ai_me_approval_created_task ON ai_me_approval(created_task_id) WHERE created_task_id IS NOT NULL;
CREATE INDEX idx_ai_me_approval_memory ON ai_me_approval(memory_id) WHERE memory_id IS NOT NULL;
CREATE INDEX idx_ai_me_approval_evidence_approval ON ai_me_approval_evidence(approval_id, created_at ASC);
CREATE INDEX idx_ai_me_approval_event_approval ON ai_me_approval_event(approval_id, created_at ASC);
