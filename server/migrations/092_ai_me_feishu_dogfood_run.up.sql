CREATE TABLE ai_me_feishu_dogfood_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    target INTEGER NOT NULL DEFAULT 20 CHECK (target > 0 AND target <= 100),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_closed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_ai_me_feishu_dogfood_run_active
    ON ai_me_feishu_dogfood_run(workspace_id)
    WHERE status = 'active';

CREATE INDEX idx_ai_me_feishu_dogfood_run_workspace_created
    ON ai_me_feishu_dogfood_run(workspace_id, created_at DESC);

INSERT INTO ai_me_feishu_dogfood_run (workspace_id, started_at)
SELECT workspace_id, min(created_at)
FROM inbox_item
WHERE details->>'source_type' = 'feishu'
GROUP BY workspace_id;
