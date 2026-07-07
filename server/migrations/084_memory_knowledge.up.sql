CREATE TABLE memory_entry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    owner_user_id UUID REFERENCES "user"(id) ON DELETE SET NULL,
    project_id UUID REFERENCES project(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN (
        'identity',
        'preference',
        'rule',
        'project_fact',
        'process',
        'history',
        'relationship',
        'technical_context'
    )),
    category TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'rejected', 'archived')),
    confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'private', 'restricted')),
    scope_type TEXT NOT NULL DEFAULT 'workspace' CHECK (scope_type IN ('user', 'workspace', 'project', 'agent')),
    scope_ref_id UUID,
    external_use_policy TEXT NOT NULL DEFAULT 'never' CHECK (external_use_policy IN ('never', 'with_approval', 'allowed')),
    source_mode TEXT NOT NULL DEFAULT 'manual' CHECK (source_mode IN ('manual', 'inferred', 'imported', 'integration')),
    created_by_type TEXT NOT NULL DEFAULT 'member' CHECK (created_by_type IN ('member', 'agent', 'system')),
    created_by_id UUID,
    verified_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (title <> ''),
    CHECK (content <> '')
);

CREATE TABLE memory_source (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_ref_id UUID,
    source_url TEXT,
    title TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}',
    captured_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memory_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memory_entry(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES memory_source(id) ON DELETE CASCADE,
    excerpt TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(memory_id, source_id, location)
);

CREATE TABLE memory_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    memory_id UUID NOT NULL REFERENCES memory_entry(id) ON DELETE CASCADE,
    used_by_type TEXT NOT NULL CHECK (used_by_type IN ('ai_me', 'agent', 'member', 'system')),
    used_by_id UUID,
    issue_id UUID REFERENCES issue(id) ON DELETE SET NULL,
    task_queue_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    chat_session_id UUID REFERENCES chat_session(id) ON DELETE SET NULL,
    action TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_document (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_url TEXT,
    attachment_id UUID REFERENCES attachment(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'archived')),
    imported_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    last_indexed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (title <> '')
);

CREATE INDEX idx_memory_entry_workspace_status ON memory_entry(workspace_id, status, updated_at DESC);
CREATE INDEX idx_memory_entry_workspace_type ON memory_entry(workspace_id, type, status);
CREATE INDEX idx_memory_entry_workspace_category ON memory_entry(workspace_id, category) WHERE category <> '';
CREATE INDEX idx_memory_entry_scope ON memory_entry(workspace_id, scope_type, scope_ref_id);
CREATE INDEX idx_memory_entry_project ON memory_entry(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_memory_source_workspace ON memory_source(workspace_id, source_type, created_at DESC);
CREATE INDEX idx_memory_evidence_memory ON memory_evidence(memory_id, created_at ASC);
CREATE INDEX idx_memory_usage_memory ON memory_usage(memory_id, created_at DESC);
CREATE INDEX idx_memory_usage_workspace ON memory_usage(workspace_id, created_at DESC);
CREATE INDEX idx_knowledge_document_workspace_status ON knowledge_document(workspace_id, status, updated_at DESC);
