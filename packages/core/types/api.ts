import type { Issue, IssueStatus, IssuePriority, IssueAssigneeType } from "./issue";
import type { MemberRole } from "./workspace";
import type { Project } from "./project";
import type { CodeContext } from "./code-context";

// Issue API
export interface CreateIssueRequest {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee_type?: IssueAssigneeType;
  assignee_id?: string;
  parent_issue_id?: string;
  project_id?: string;
  due_date?: string;
  code_context?: CodeContext;
  attachment_ids?: string[];
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee_type?: IssueAssigneeType | null;
  assignee_id?: string | null;
  position?: number;
  due_date?: string | null;
  parent_issue_id?: string | null;
  project_id?: string | null;
}

export interface ListIssuesParams {
  limit?: number;
  offset?: number;
  workspace_id?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee_id?: string;
  assignee_ids?: string[];
  creator_id?: string;
  project_id?: string;
  open_only?: boolean;
}

/** Raw backend response shape for `GET /api/issues`. */
export interface ListIssuesResponse {
  issues: Issue[];
  total: number;
}

/** Per-status bucket in the paginated issue cache. `total` is the server count (all pages), not the length of `issues`. */
export interface IssueStatusBucket {
  issues: Issue[];
  total: number;
}

/**
 * Frontend cache shape for the issue list. Data is bucketed by status so
 * each column can paginate independently. Assembled from per-status
 * `api.listIssues` responses by the query functions in `issues/queries.ts`.
 */
export interface ListIssuesCache {
  byStatus: Partial<Record<IssueStatus, IssueStatusBucket>>;
}

export interface SearchIssueResult extends Issue {
  match_source: "title" | "description" | "comment";
  matched_snippet?: string;
}

export interface SearchIssuesResponse {
  issues: SearchIssueResult[];
  total: number;
}

export interface SearchProjectResult extends Project {
  match_source: "title" | "description";
  matched_snippet?: string;
}

export interface SearchProjectsResponse {
  projects: SearchProjectResult[];
  total: number;
}

export interface UpdateMeRequest {
  name?: string;
  avatar_url?: string;
  language?: string;
}

export interface CreateMemberRequest {
  email: string;
  role?: MemberRole;
}

export interface UpdateMemberRequest {
  role: MemberRole;
}

export interface FeishuIntegrationStatus {
  provider: "feishu" | string;
  event_mode: "webhook" | "websocket" | string;
  incoming_configured: boolean;
  outgoing_configured: boolean;
  webhook_configured: boolean;
  signature_configured: boolean;
  websocket_configured: boolean;
  workspace_configured: boolean;
  workspace_matches: boolean;
  owner_configured: boolean;
  allowed_chat_configured: boolean;
  group_message_policy: string;
  callback_path: string;
  required_events: string[];
  required_scopes: string[];
  warnings: string[];
}

export interface FeishuMessageLog {
  inbox_item_id: string;
  workspace_id: string;
  recipient_id: string;
  inbox_title: string;
  inbound_text: string;
  read: boolean;
  archived: boolean;
  received_at: string;
  message_id: string;
  event_id: string;
  chat_id: string;
  chat_type: string;
  sender_open_id: string;
  sender_user_id: string;
  sender_union_id: string;
  gate_reason: string;
  approval_id: string;
  approval_status: string;
  risk_level: string;
  execution_status: string;
  execution_error: string;
  approved_at: string | null;
  executed_at: string | null;
  reply_text: string;
  draft_source: string;
  draft_provider: string;
  draft_model: string;
  quality_score: number;
  quality_note: string;
  quality_scored_at: string | null;
}

export interface FeishuDogfoodSummary {
  total_received: number;
  received_today: number;
  approvals_created: number;
  pending_approval: number;
  rejected: number;
  sent: number;
  send_failed: number;
  ai_drafted: number;
  quality_reviewed: number;
  avg_quality_score: number;
  dogfood_target: number;
  dogfood_completed: number;
  dogfood_remaining: number;
  first_received_at: string | null;
  last_received_at: string | null;
}

export interface AIMeCostControl {
  currency: string;
  draft_call_count: number;
  estimated_draft_cost_cents: number;
  daily_budget_cents: number;
  remaining_budget_cents: number;
  budget_status: string;
  worker_task_count: number;
  worker_input_tokens: number;
  worker_output_tokens: number;
  worker_cache_read_tokens: number;
  worker_cache_write_tokens: number;
}

export interface FeishuReliabilitySummary {
  webhook_events: number;
  duplicate_events: number;
  accepted_events: number;
  ignored_events: number;
  failed_events: number;
  rejected_events: number;
  signature_verified_events: number;
  replay_protected_events: number;
  events_today: number;
  last_event_at: string | null;
}

export interface FeishuDeliverySummary {
  deliveries: number;
  sending: number;
  succeeded: number;
  failed: number;
  dead_letter: number;
  attempts: number;
  last_delivery_at: string | null;
}

export interface AIMeQualitySummary {
  reviewed: number;
  avg_score: number;
  good: number;
  poor: number;
  accepted: number;
  needs_retry: number;
  wrong: number;
  last_reviewed_at: string | null;
}

export interface AIMeModelRouting {
  default_provider: string;
  default_model: string;
  draft_provider: string;
  draft_model: string;
  worker_policy: string;
  daily_budget_cents: number;
  budget_status: string;
  recommended_next_actions: string[];
}

export interface FeishuDogfoodChecklistItem {
  key: string;
  title: string;
  description: string;
  completed: boolean;
}

export interface FeishuWebhookEvent {
  id: string;
  event_key: string;
  event_id: string;
  message_id: string;
  event_type: string;
  status: string;
  reason: string;
  signature_verified: boolean;
  token_verified: boolean;
  replay_protected: boolean;
  duplicate_count: number;
  request_timestamp: string | null;
  inbox_item_id: string | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeishuDelivery {
  id: string;
  approval_id: string | null;
  source_message_id: string;
  reply_message_id: string;
  status: string;
  attempt_count: number;
  last_error: string;
  next_retry_at: string | null;
  sent_at: string | null;
  updated_at: string;
}

export interface FeishuDogfoodCase {
  slot: number;
  message_id: string;
  approval_id: string;
  title: string;
  stage: string;
  completed: boolean;
  blocking_reason: string;
  received_at: string | null;
}

export interface AIMeOnboardingStep {
  key: string;
  title: string;
  description: string;
  completed: boolean;
}

export interface AIMeOnboardingStatus {
  completed: boolean;
  completed_steps: number;
  total_steps: number;
  steps: AIMeOnboardingStep[];
}

export interface FeishuDogfoodPanel {
  status: FeishuIntegrationStatus;
  summary: FeishuDogfoodSummary;
  cost: AIMeCostControl;
  reliability: FeishuReliabilitySummary;
  delivery: FeishuDeliverySummary;
  quality: AIMeQualitySummary;
  model_route: AIMeModelRouting;
  onboarding: AIMeOnboardingStatus;
  checklist: FeishuDogfoodChecklistItem[];
  cases: FeishuDogfoodCase[];
  logs: FeishuMessageLog[];
  events: FeishuWebhookEvent[];
  deliveries: FeishuDelivery[];
}

// Personal Access Tokens
export interface PersonalAccessToken {
  id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface CreatePersonalAccessTokenRequest {
  name: string;
  expires_in_days?: number;
}

export interface CreatePersonalAccessTokenResponse extends PersonalAccessToken {
  token: string;
}

// Pagination
export interface PaginationParams {
  limit?: number;
  offset?: number;
}
