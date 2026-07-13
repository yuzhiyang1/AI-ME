export type AIMeThinkIntent =
  | "triage"
  | "plan"
  | "reply"
  | "assign"
  | "general";

export type AIMeThinkMode =
  | "llm"
  | "disabled"
  | "unconfigured"
  | "provider_error"
  | "fallback";

export type AIMeRiskLevel = "low" | "medium" | "high";

export type AIMeActionType =
  | "create_task"
  | "assign_worker"
  | "draft_reply"
  | "send_external_message"
  | "post_internal_comment"
  | "ask_user"
  | "no_action";

export interface AIMeTurnInput {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AIMeThinkRequest {
  input: string;
  request_id?: string;
  intent?: AIMeThinkIntent;
  source_type?: "manual" | "issue" | "inbox" | "feishu" | "email" | "github";
  source_ref_id?: string;
  issue_id?: string;
  conversation?: AIMeTurnInput[];
  need_worker_plan?: boolean;
}

export interface AIMeSuggestedAction {
  type: AIMeActionType;
  title: string;
  description: string;
  target_agent_id?: string;
  target_agent_name?: string;
  issue_id?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  requires_approval: boolean;
}

export interface AIMeEvidence {
  type: string;
  label: string;
  ref_id?: string;
  quote?: string;
}

export interface AIMeWorkspaceContext {
  id: string;
  name: string;
  slug: string;
  context?: string;
}

export interface AIMeIssueContext {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assignee_type?: string;
  assignee_id?: string;
}

export interface AIMeAgentContext {
  id: string;
  name: string;
  description: string;
  provider: string;
  status: string;
  runtime_status: string;
  model?: string;
}

export interface AIMeMemoryContext {
  id: string;
  type: string;
  category?: string;
  title: string;
  content: string;
  summary?: string;
  confidence: number;
  sensitivity: string;
  scope_type: string;
  external_use_policy: string;
}

export interface AIMeContextSummary {
  workspace: AIMeWorkspaceContext;
  issues: AIMeIssueContext[];
  agents: AIMeAgentContext[];
  memories: AIMeMemoryContext[];
}

export interface AIMePolicyWorkingHours {
  start: string;
  end: string;
}

export interface AIMePolicyContext {
  enabled: boolean;
  autonomy_level: string;
  approval_mode: string;
  timezone: string;
  working_hours: AIMePolicyWorkingHours;
  in_working_hours: boolean;
  model_provider: string;
  model_name: string;
}

export interface AIMeCockpitSummary {
  active_tasks: number;
  queued_tasks: number;
  running_tasks: number;
  completed_tasks_today: number;
  failed_tasks_today: number;
  pending_decisions: number;
  high_risk_pending: number;
  waiting_external: number;
  execution_succeeded: number;
  execution_failed: number;
  external_reply_pending: number;
  assign_worker_succeeded: number;
  external_reply_succeeded: number;
  active_memories: number;
  memory_used_today: number;
  unread_inbox: number;
  active_issues: number;
}

export interface AIMeThinkResponse {
  id: string;
  mode: AIMeThinkMode;
  provider: string;
  model: string;
  configured: boolean;
  summary: string;
  risk_level: AIMeRiskLevel;
  confidence: number;
  need_approval: boolean;
  approval_id?: string;
  approval_ids?: string[];
  reply_draft: string;
  reasoning_summary: string;
  actions: AIMeSuggestedAction[];
  evidence: AIMeEvidence[];
  context: AIMeContextSummary;
  policy: AIMePolicyContext;
  configuration_required: boolean;
  error?: string;
  created_at: string;
}
