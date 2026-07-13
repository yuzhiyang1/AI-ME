UPDATE ai_me_run SET status = 'failed' WHERE status = 'rejected';
UPDATE ai_me_tool_call SET status = 'failed' WHERE status = 'rejected';

ALTER TABLE ai_me_run DROP CONSTRAINT IF EXISTS ai_me_run_status_check;
ALTER TABLE ai_me_run ADD CONSTRAINT ai_me_run_status_check CHECK (status IN (
    'queued', 'running', 'waiting', 'waiting_approval',
    'succeeded', 'failed', 'cancelled'
));

ALTER TABLE ai_me_tool_call DROP CONSTRAINT IF EXISTS ai_me_tool_call_status_check;
ALTER TABLE ai_me_tool_call ADD CONSTRAINT ai_me_tool_call_status_check CHECK (status IN (
    'pending', 'waiting_approval', 'running',
    'succeeded', 'failed', 'cancelled'
));
