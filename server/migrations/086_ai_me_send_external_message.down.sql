ALTER TABLE ai_me_approval
    DROP CONSTRAINT IF EXISTS ai_me_approval_action_type_check;

ALTER TABLE ai_me_approval
    ADD CONSTRAINT ai_me_approval_action_type_check CHECK (action_type IN (
        'create_issue',
        'assign_worker',
        'draft_reply',
        'post_internal_comment',
        'confirm_memory',
        'no_action'
    ));
