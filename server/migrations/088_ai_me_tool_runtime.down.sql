DROP INDEX IF EXISTS idx_ai_me_approval_tool_call;

ALTER TABLE ai_me_approval
    DROP COLUMN IF EXISTS tool_call_id;

DROP TABLE IF EXISTS ai_me_run_step;
DROP TABLE IF EXISTS ai_me_tool_call;
DROP TABLE IF EXISTS ai_me_run;

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
UPDATE issue
SET origin_type = NULL,
    origin_id = NULL
WHERE origin_type = 'ai_me';
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
    CHECK (origin_type IN ('autopilot', 'quick_create'));
