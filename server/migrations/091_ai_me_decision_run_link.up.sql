ALTER TABLE ai_me_approval
    ADD COLUMN run_id UUID REFERENCES ai_me_run(id) ON DELETE SET NULL;

UPDATE ai_me_approval AS approval
SET run_id = run.id
FROM ai_me_run AS run
WHERE approval.run_id IS NULL
  AND approval.workspace_id = run.workspace_id
  AND approval.id::text = run.input->>'approval_id';

UPDATE ai_me_approval AS approval
SET run_id = tool_call.run_id
FROM ai_me_tool_call AS tool_call
JOIN ai_me_run AS run ON run.id = tool_call.run_id
WHERE approval.run_id IS NULL
  AND approval.tool_call_id = tool_call.id
  AND approval.workspace_id = run.workspace_id;

CREATE INDEX idx_ai_me_approval_run
    ON ai_me_approval(run_id)
    WHERE run_id IS NOT NULL;
