export type AIApprovalSourceType =
  | "ai_me_think"
  | "exception"
  | "inbox"
  | "issue"
  | "comment"
  | "agent_task"
  | "memory"
  | "feishu"
  | "email"
  | "github"
  | "manual";

export type AIApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "observing"
  | "taken_over"
  | "expired";

export type AIApprovalRiskLevel = "low" | "medium" | "high";

export type AIApprovalReversibility =
  | "reversible"
  | "partially_reversible"
  | "irreversible";

export type AIApprovalActionType =
  | "create_issue"
  | "assign_worker"
  | "draft_reply"
  | "send_external_message"
  | "post_internal_comment"
  | "confirm_memory"
  | "no_action";

export type AIApprovalExecutionStatus =
  | "not_started"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type AIApprovalEvidenceType =
  | "user_input"
  | "issue"
  | "comment"
  | "activity"
  | "agent_task"
  | "memory"
  | "document"
  | "feishu"
  | "email"
  | "github"
  | "ci"
  | "log";

export type AIApprovalEventType =
  | "created"
  | "edited"
  | "approved"
  | "rejected"
  | "observing"
  | "taken_over"
  | "execution_started"
  | "execution_succeeded"
  | "execution_failed"
  | "expired";

export interface AIApprovalEvidence {
  id: string;
  approval_id: string;
  workspace_id: string;
  evidence_type: AIApprovalEvidenceType | string;
  label: string;
  ref_id: string | null;
  source_url: string | null;
  quote: string;
  metadata: unknown;
  created_at: string;
}

export interface AIApprovalEvent {
  id: string;
  approval_id: string;
  workspace_id: string;
  actor_type: string;
  actor_id: string | null;
  event_type: AIApprovalEventType | string;
  from_status: AIApprovalStatus | string | null;
  to_status: AIApprovalStatus | string | null;
  payload: unknown;
  created_at: string;
}

export interface AIApproval {
  id: string;
  workspace_id: string;
  requester_user_id: string | null;
  source_type: AIApprovalSourceType | string;
  source_ref_id: string | null;
  source_url: string | null;
  issue_id: string | null;
  inbox_item_id: string | null;
  task_queue_id: string | null;
  memory_id: string | null;
  title: string;
  summary: string;
  status: AIApprovalStatus | string;
  risk_level: AIApprovalRiskLevel | string;
  confidence: number;
  reversibility: AIApprovalReversibility | string;
  action_type: AIApprovalActionType | string;
  action_title: string;
  action_description: string;
  original_payload: unknown;
  final_payload: unknown;
  ai_reasoning_summary: string;
  approval_note: string;
  rejection_reason: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  observed_by: string | null;
  observed_at: string | null;
  taken_over_by: string | null;
  taken_over_at: string | null;
  executed_at: string | null;
  execution_status: AIApprovalExecutionStatus | string;
  execution_error: string;
  created_issue_id: string | null;
  created_task_id: string | null;
  created_comment_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  evidence?: AIApprovalEvidence[];
  events?: AIApprovalEvent[];
}

export interface ListAIApprovalsParams {
  status?: AIApprovalStatus;
  risk_level?: AIApprovalRiskLevel;
  action_type?: AIApprovalActionType;
  source_type?: AIApprovalSourceType;
  issue_id?: string;
  limit?: number;
  offset?: number;
}

export interface ListAIApprovalsResponse {
  approvals: AIApproval[];
  total: number;
}

export interface AIApprovalStats {
  total: number;
  pending: number;
  high_risk_pending: number;
  observing: number;
  approved: number;
  rejected: number;
  taken_over: number;
  expired: number;
  succeeded: number;
  failed: number;
}

export interface CreateAIApprovalEvidenceRequest {
  evidence_type?: AIApprovalEvidenceType;
  label: string;
  ref_id?: string;
  source_url?: string;
  quote?: string;
  metadata?: unknown;
}

export interface CreateAIApprovalRequest {
  source_type?: AIApprovalSourceType;
  source_ref_id?: string;
  source_url?: string;
  issue_id?: string;
  inbox_item_id?: string;
  task_queue_id?: string;
  memory_id?: string;
  title: string;
  summary?: string;
  risk_level?: AIApprovalRiskLevel;
  confidence?: number;
  reversibility?: AIApprovalReversibility;
  action_type: AIApprovalActionType;
  action_title?: string;
  action_description?: string;
  original_payload?: unknown;
  final_payload?: unknown;
  ai_reasoning_summary?: string;
  expires_at?: string;
  evidence?: CreateAIApprovalEvidenceRequest[];
}

export interface UpdateAIApprovalRequest {
  title?: string;
  summary?: string;
  risk_level?: AIApprovalRiskLevel;
  confidence?: number;
  reversibility?: AIApprovalReversibility;
  action_title?: string;
  action_description?: string;
  final_payload?: unknown;
  approval_note?: string;
  expires_at?: string | null;
}

export interface AIApprovalTransitionRequest {
  note?: string;
  reason?: string;
  final_payload?: unknown;
}

export interface AIApprovalQualityRequest {
  score: number;
  note?: string;
  outcome?: string;
}
