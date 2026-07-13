DROP INDEX IF EXISTS idx_ai_me_approval_run;

ALTER TABLE ai_me_approval
    DROP COLUMN IF EXISTS run_id;
