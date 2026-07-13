CREATE UNIQUE INDEX idx_issue_ai_me_origin_unique
    ON issue(workspace_id, origin_id)
    WHERE origin_type = 'ai_me' AND origin_id IS NOT NULL;
