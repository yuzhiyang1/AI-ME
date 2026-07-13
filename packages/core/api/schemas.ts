import { z } from "zod";
import type {
  AIApproval,
  AIApprovalStats,
  AIMeOnboardingStatus,
  AIMeCockpitSummary,
  AIMeThinkResponse,
  FeishuDogfoodPanel,
  FeishuIntegrationStatus,
  KnowledgeDocument,
  ListAIApprovalsResponse,
  ListKnowledgeDocumentsResponse,
  ListMemoryEntriesResponse,
  ListIssuesResponse,
  MemoryEntry,
  TimelineEntry,
} from "../types";

// ---------------------------------------------------------------------------
// Schemas for the highest-risk API endpoints — those whose responses drive
// the issue detail page (timeline, comments, subscribers) and the issues
// list. These are the surfaces that white-screened in #2143 / #2147 / #2192.
//
// These schemas are intentionally LENIENT:
//   - String enums are stored as `z.string()` rather than `z.enum([...])`.
//     A new server-side enum value should render as a generic fallback in
//     the UI, never crash a `safeParse`.
//   - Optional fields are unioned with `null` and given fallbacks where
//     existing UI code already coerces them.
//   - Arrays default to `[]` so a missing `reactions` / `attachments` /
//     `entries` field doesn't take the page down.
//   - Every object schema ends with `.loose()` so unknown server-side
//     fields pass through unchanged. zod 4's `.object()` defaults to STRIP,
//     which would silently delete fields the schema didn't explicitly list
//     — fine while the TS type doesn't claim them, but the moment a future
//     PR adds a TS field without updating the schema, the cast `as T` lies
//     and the field shows up as `undefined` at runtime. `.loose()` removes
//     that synchronisation hazard.
//
// These schemas are deliberately not typed as `z.ZodType<TimelineEntry>` /
// `z.ZodType<Issue>` etc. — the strict TS types narrow string fields to
// literal unions, which would defeat the leniency above. `parseWithFallback`
// returns the parsed value cast to the caller-supplied `T`, so the strict
// type still flows out at the call site; the schema only guards shape.
// ---------------------------------------------------------------------------

const ReactionSchema = z.object({
  id: z.string(),
  comment_id: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  emoji: z.string(),
  created_at: z.string(),
});

const AttachmentSchema = z.object({
  id: z.string(),
}).loose();

// All object schemas use `.loose()` so unknown server-side fields pass
// through unchanged. zod 4's `.object()` defaults to STRIP, which would
// silently drop new fields and surface as a "field neither showed up in
// the UI" mystery the next time the TS type adopted them but the schema
// wasn't updated in lock-step. `.loose()` removes that synchronisation
// hazard — the schema validates the shape it knows about and leaves the
// rest alone.
const TimelineEntrySchema = z.object({
  type: z.string(),
  id: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
  action: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  comment_type: z.string().optional(),
  reactions: z.array(ReactionSchema).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  coalesced_count: z.number().optional(),
}).loose();

// /timeline returns a flat array of TimelineEntry, oldest first. The
// previously cursor-paginated wrapper was removed (#1929) — at observed data
// sizes (p99 ~30 entries per issue) paged delivery only created bugs.
export const TimelineEntriesSchema = z.array(TimelineEntrySchema);

export const EMPTY_TIMELINE_ENTRIES: TimelineEntry[] = [];

export const CommentSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  author_type: z.string(),
  author_id: z.string(),
  content: z.string(),
  type: z.string(),
  parent_id: z.string().nullable(),
  reactions: z.array(ReactionSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const CommentsListSchema = z.array(CommentSchema);

const CodeContextSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("default_repo"),
  }).loose(),
  z.object({
    type: z.literal("local_path"),
    path: z.string(),
  }).loose(),
]);

const IssueSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  number: z.number(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  assignee_type: z.string().nullable(),
  assignee_id: z.string().nullable(),
  creator_type: z.string(),
  creator_id: z.string(),
  parent_issue_id: z.string().nullable(),
  project_id: z.string().nullable(),
  code_context: CodeContextSchema.default({ type: "default_repo" }),
  position: z.number(),
  due_date: z.string().nullable(),
  reactions: z.array(z.unknown()).optional(),
  labels: z.array(z.unknown()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const ListIssuesResponseSchema = z.object({
  issues: z.array(IssueSchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_LIST_ISSUES_RESPONSE: ListIssuesResponse = {
  issues: [],
  total: 0,
};

const SubscriberSchema = z.object({
  issue_id: z.string(),
  user_type: z.string(),
  user_id: z.string(),
  reason: z.string(),
  created_at: z.string(),
}).loose();

export const SubscribersListSchema = z.array(SubscriberSchema);

export const ChildIssuesResponseSchema = z.object({
  issues: z.array(IssueSchema).default([]),
}).loose();

export const ChatSessionSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string(),
  creator_id: z.string(),
  title: z.string(),
  status: z.string(),
  code_context: CodeContextSchema.default({ type: "default_repo" }),
  has_unread: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const ChatMessageSchema = z.object({
  id: z.string(),
  chat_session_id: z.string(),
  role: z.string(),
  content: z.string(),
  task_id: z.string().nullable(),
  created_at: z.string(),
  failure_reason: z.string().nullable().optional(),
  elapsed_ms: z.number().nullable().optional(),
}).loose();

export const ChatSessionsSchema = z.array(ChatSessionSchema);
export const ChatMessagesSchema = z.array(ChatMessageSchema);
export const ChatPendingTaskSchema = z.object({
  task_id: z.string().optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
}).loose();
export const PendingChatTasksResponseSchema = z.object({
  tasks: z.array(z.object({
    task_id: z.string(),
    status: z.string(),
    chat_session_id: z.string(),
  }).loose()).default([]),
}).loose();
export const SendChatMessageResponseSchema = z.object({
  message_id: z.string(),
  task_id: z.string(),
  created_at: z.string(),
}).loose();

const MemorySourceSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  source_type: z.string(),
  source_ref_id: z.string().nullable(),
  source_url: z.string().nullable(),
  title: z.string(),
  excerpt: z.string(),
  metadata: z.unknown(),
  captured_at: z.string().nullable(),
  created_at: z.string(),
}).loose();

const MemoryEvidenceSchema = z.object({
  id: z.string(),
  memory_id: z.string(),
  source_id: z.string(),
  excerpt: z.string(),
  location: z.string(),
  confidence: z.number(),
  created_at: z.string(),
  source: MemorySourceSchema,
}).loose();

const MemoryUsageSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  memory_id: z.string(),
  used_by_type: z.string(),
  used_by_id: z.string().nullable(),
  issue_id: z.string().nullable(),
  task_queue_id: z.string().nullable(),
  chat_session_id: z.string().nullable(),
  action: z.string(),
  outcome: z.string(),
  created_at: z.string(),
}).loose();

export const MemoryEntrySchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  owner_user_id: z.string().nullable(),
  project_id: z.string().nullable(),
  type: z.string(),
  category: z.string(),
  title: z.string(),
  content: z.string(),
  summary: z.string(),
  status: z.string(),
  confidence: z.number(),
  sensitivity: z.string(),
  scope_type: z.string(),
  scope_ref_id: z.string().nullable(),
  external_use_policy: z.string(),
  source_mode: z.string(),
  created_by_type: z.string(),
  created_by_id: z.string().nullable(),
  verified_by: z.string().nullable(),
  verified_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  evidence: z.array(MemoryEvidenceSchema).optional(),
  usage: z.array(MemoryUsageSchema).optional(),
}).loose();

export const EMPTY_MEMORY_ENTRY: MemoryEntry = {
  id: "",
  workspace_id: "",
  owner_user_id: null,
  project_id: null,
  type: "preference",
  category: "",
  title: "",
  content: "",
  summary: "",
  status: "candidate",
  confidence: 0,
  sensitivity: "normal",
  scope_type: "workspace",
  scope_ref_id: null,
  external_use_policy: "with_approval",
  source_mode: "manual",
  created_by_type: "",
  created_by_id: null,
  verified_by: null,
  verified_at: null,
  last_used_at: null,
  expires_at: null,
  archived_at: null,
  created_at: "",
  updated_at: "",
  evidence: [],
  usage: [],
};

export const ListMemoryEntriesResponseSchema = z.object({
  memories: z.array(MemoryEntrySchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_LIST_MEMORY_ENTRIES_RESPONSE: ListMemoryEntriesResponse = {
  memories: [],
  total: 0,
};

export const KnowledgeDocumentSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  source_type: z.string(),
  source_url: z.string().nullable(),
  attachment_id: z.string().nullable(),
  status: z.string(),
  imported_by: z.string().nullable(),
  metadata: z.unknown(),
  last_indexed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const EMPTY_KNOWLEDGE_DOCUMENT: KnowledgeDocument = {
  id: "",
  workspace_id: "",
  title: "",
  source_type: "manual",
  source_url: null,
  attachment_id: null,
  status: "queued",
  imported_by: null,
  metadata: {},
  last_indexed_at: null,
  created_at: "",
  updated_at: "",
};

export const ListKnowledgeDocumentsResponseSchema = z.object({
  documents: z.array(KnowledgeDocumentSchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_LIST_KNOWLEDGE_DOCUMENTS_RESPONSE: ListKnowledgeDocumentsResponse = {
  documents: [],
  total: 0,
};

const AIApprovalEvidenceSchema = z.object({
  id: z.string(),
  approval_id: z.string(),
  workspace_id: z.string(),
  evidence_type: z.string(),
  label: z.string(),
  ref_id: z.string().nullable(),
  source_url: z.string().nullable(),
  quote: z.string(),
  metadata: z.unknown(),
  created_at: z.string(),
}).loose();

const AIApprovalEventSchema = z.object({
  id: z.string(),
  approval_id: z.string(),
  workspace_id: z.string(),
  actor_type: z.string(),
  actor_id: z.string().nullable(),
  event_type: z.string(),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  payload: z.unknown(),
  created_at: z.string(),
}).loose();

export const AIApprovalSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  requester_user_id: z.string().nullable(),
  source_type: z.string(),
  source_ref_id: z.string().nullable(),
  source_url: z.string().nullable(),
  issue_id: z.string().nullable(),
  inbox_item_id: z.string().nullable(),
  task_queue_id: z.string().nullable(),
  memory_id: z.string().nullable(),
  tool_call_id: z.string().nullable().optional().default(null),
  title: z.string(),
  summary: z.string(),
  status: z.string(),
  risk_level: z.string(),
  confidence: z.number(),
  reversibility: z.string(),
  action_type: z.string(),
  action_title: z.string(),
  action_description: z.string(),
  original_payload: z.unknown(),
  final_payload: z.unknown(),
  ai_reasoning_summary: z.string(),
  approval_note: z.string(),
  rejection_reason: z.string(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  rejected_by: z.string().nullable(),
  rejected_at: z.string().nullable(),
  observed_by: z.string().nullable(),
  observed_at: z.string().nullable(),
  taken_over_by: z.string().nullable(),
  taken_over_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  execution_status: z.string(),
  execution_error: z.string(),
  created_issue_id: z.string().nullable(),
  created_task_id: z.string().nullable(),
  created_comment_id: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  evidence: z.array(AIApprovalEvidenceSchema).optional(),
  events: z.array(AIApprovalEventSchema).optional(),
}).loose();

export const EMPTY_AI_APPROVAL: AIApproval = {
  id: "",
  workspace_id: "",
  requester_user_id: null,
  source_type: "manual",
  source_ref_id: null,
  source_url: null,
  issue_id: null,
  inbox_item_id: null,
  task_queue_id: null,
  memory_id: null,
  tool_call_id: null,
  title: "",
  summary: "",
  status: "pending",
  risk_level: "medium",
  confidence: 0,
  reversibility: "partially_reversible",
  action_type: "no_action",
  action_title: "",
  action_description: "",
  original_payload: {},
  final_payload: {},
  ai_reasoning_summary: "",
  approval_note: "",
  rejection_reason: "",
  approved_by: null,
  approved_at: null,
  rejected_by: null,
  rejected_at: null,
  observed_by: null,
  observed_at: null,
  taken_over_by: null,
  taken_over_at: null,
  executed_at: null,
  execution_status: "not_started",
  execution_error: "",
  created_issue_id: null,
  created_task_id: null,
  created_comment_id: null,
  expires_at: null,
  created_at: "",
  updated_at: "",
  evidence: [],
  events: [],
};

export const ListAIApprovalsResponseSchema = z.object({
  approvals: z.array(AIApprovalSchema).default([]),
  total: z.number().default(0),
}).loose();

export const EMPTY_LIST_AI_APPROVALS_RESPONSE: ListAIApprovalsResponse = {
  approvals: [],
  total: 0,
};

export const AIApprovalStatsSchema = z.object({
  total: z.number().default(0),
  pending: z.number().default(0),
  high_risk_pending: z.number().default(0),
  observing: z.number().default(0),
  approved: z.number().default(0),
  rejected: z.number().default(0),
  taken_over: z.number().default(0),
  expired: z.number().default(0),
  succeeded: z.number().default(0),
  failed: z.number().default(0),
}).loose();

export const EMPTY_AI_APPROVAL_STATS: AIApprovalStats = {
  total: 0,
  pending: 0,
  high_risk_pending: 0,
  observing: 0,
  approved: 0,
  rejected: 0,
  taken_over: 0,
  expired: 0,
  succeeded: 0,
  failed: 0,
};

export const FeishuIntegrationStatusSchema = z.object({
  provider: z.string().default("feishu"),
  event_mode: z.string().default("webhook"),
  incoming_configured: z.boolean().default(false),
  outgoing_configured: z.boolean().default(false),
  webhook_configured: z.boolean().default(false),
  signature_configured: z.boolean().default(false),
  websocket_configured: z.boolean().default(false),
  workspace_configured: z.boolean().default(false),
  workspace_matches: z.boolean().default(false),
  owner_configured: z.boolean().default(false),
  allowed_chat_configured: z.boolean().default(false),
  group_message_policy: z.string().default("mention"),
  callback_path: z.string().default("/api/integrations/feishu/webhook"),
  required_events: z.array(z.string()).default([]),
  required_scopes: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
}).loose();

export const EMPTY_FEISHU_INTEGRATION_STATUS: FeishuIntegrationStatus = {
  provider: "feishu",
  event_mode: "webhook",
  incoming_configured: false,
  outgoing_configured: false,
  webhook_configured: false,
  signature_configured: false,
  websocket_configured: false,
  workspace_configured: false,
  workspace_matches: false,
  owner_configured: false,
  allowed_chat_configured: false,
  group_message_policy: "mention",
  callback_path: "/api/integrations/feishu/webhook",
  required_events: [],
  required_scopes: [],
  warnings: [],
};

const FeishuMessageLogSchema = z.object({
  inbox_item_id: z.string().default(""),
  workspace_id: z.string().default(""),
  recipient_id: z.string().default(""),
  inbox_title: z.string().default(""),
  inbound_text: z.string().default(""),
  read: z.boolean().default(false),
  archived: z.boolean().default(false),
  received_at: z.string().default(""),
  message_id: z.string().default(""),
  event_id: z.string().default(""),
  chat_id: z.string().default(""),
  chat_type: z.string().default(""),
  sender_open_id: z.string().default(""),
  sender_user_id: z.string().default(""),
  sender_union_id: z.string().default(""),
  gate_reason: z.string().default(""),
  approval_id: z.string().default(""),
  approval_status: z.string().default(""),
  risk_level: z.string().default(""),
  execution_status: z.string().default(""),
  execution_error: z.string().default(""),
  approved_at: z.string().nullable().default(null),
  executed_at: z.string().nullable().default(null),
  reply_text: z.string().default(""),
  draft_source: z.string().default(""),
  draft_provider: z.string().default(""),
  draft_model: z.string().default(""),
  draft_input_tokens: z.number().default(0),
  draft_output_tokens: z.number().default(0),
  draft_cache_read_tokens: z.number().default(0),
  draft_cost_microusd: z.number().default(0),
  quality_score: z.number().default(0),
  quality_note: z.string().default(""),
  quality_scored_at: z.string().nullable().default(null),
}).loose();

const FeishuDogfoodSummarySchema = z.object({
  total_received: z.number().default(0),
  received_today: z.number().default(0),
  approvals_created: z.number().default(0),
  pending_approval: z.number().default(0),
  rejected: z.number().default(0),
  sent: z.number().default(0),
  send_failed: z.number().default(0),
  ai_drafted: z.number().default(0),
  quality_reviewed: z.number().default(0),
  avg_quality_score: z.number().default(0),
  dogfood_target: z.number().default(20),
  dogfood_completed: z.number().default(0),
  dogfood_remaining: z.number().default(20),
  first_received_at: z.string().nullable().default(null),
  last_received_at: z.string().nullable().default(null),
}).loose();

const AIMeCostControlSchema = z.object({
  currency: z.string().default("USD"),
  draft_call_count: z.number().default(0),
  estimated_draft_cost_cents: z.number().default(0),
  draft_cost_microusd: z.number().default(0),
  daily_budget_cents: z.number().default(0),
  daily_budget_microusd: z.number().default(0),
  remaining_budget_cents: z.number().default(0),
  remaining_budget_microusd: z.number().default(0),
  budget_configured: z.boolean().default(false),
  budget_status: z.string().default("unconfigured"),
  worker_task_count: z.number().default(0),
  worker_input_tokens: z.number().default(0),
  worker_output_tokens: z.number().default(0),
  worker_cache_read_tokens: z.number().default(0),
  worker_cache_write_tokens: z.number().default(0),
}).loose();

const FeishuReliabilitySummarySchema = z.object({
  webhook_events: z.number().default(0),
  duplicate_events: z.number().default(0),
  accepted_events: z.number().default(0),
  ignored_events: z.number().default(0),
  failed_events: z.number().default(0),
  rejected_events: z.number().default(0),
  signature_verified_events: z.number().default(0),
  replay_protected_events: z.number().default(0),
  events_today: z.number().default(0),
  last_event_at: z.string().nullable().default(null),
}).loose();

const FeishuDeliverySummarySchema = z.object({
  deliveries: z.number().default(0),
  sending: z.number().default(0),
  succeeded: z.number().default(0),
  failed: z.number().default(0),
  dead_letter: z.number().default(0),
  attempts: z.number().default(0),
  last_delivery_at: z.string().nullable().default(null),
}).loose();

const AIMeQualitySummarySchema = z.object({
  reviewed: z.number().default(0),
  avg_score: z.number().default(0),
  good: z.number().default(0),
  poor: z.number().default(0),
  accepted: z.number().default(0),
  needs_retry: z.number().default(0),
  wrong: z.number().default(0),
  last_reviewed_at: z.string().nullable().default(null),
}).loose();

const AIMeModelRoutingSchema = z.object({
  default_provider: z.string().default("deepseek"),
  default_model: z.string().default("deepseek-v4-flash"),
  draft_provider: z.string().default("deepseek"),
  draft_model: z.string().default("deepseek-v4-flash"),
  worker_policy: z.string().default(""),
  daily_budget_cents: z.number().default(0),
  budget_status: z.string().default("ok"),
  recommended_next_actions: z.array(z.string()).default([]),
}).loose();

const FeishuDogfoodChecklistItemSchema = z.object({
  key: z.string().default(""),
  title: z.string().default(""),
  description: z.string().default(""),
  completed: z.boolean().default(false),
}).loose();

const FeishuWebhookEventSchema = z.object({
  id: z.string().default(""),
  event_key: z.string().default(""),
  event_id: z.string().default(""),
  message_id: z.string().default(""),
  event_type: z.string().default(""),
  status: z.string().default(""),
  reason: z.string().default(""),
  signature_verified: z.boolean().default(false),
  token_verified: z.boolean().default(false),
  replay_protected: z.boolean().default(false),
  duplicate_count: z.number().default(0),
  request_timestamp: z.string().nullable().default(null),
  inbox_item_id: z.string().nullable().default(null),
  approval_id: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

const FeishuDeliverySchema = z.object({
  id: z.string().default(""),
  approval_id: z.string().nullable().default(null),
  source_message_id: z.string().default(""),
  reply_message_id: z.string().default(""),
  status: z.string().default(""),
  attempt_count: z.number().default(0),
  last_error: z.string().default(""),
  next_retry_at: z.string().nullable().default(null),
  sent_at: z.string().nullable().default(null),
  updated_at: z.string().default(""),
}).loose();

const FeishuDogfoodCaseSchema = z.object({
  slot: z.number().default(0),
  message_id: z.string().default(""),
  approval_id: z.string().default(""),
  title: z.string().default(""),
  stage: z.string().default("awaiting_message"),
  completed: z.boolean().default(false),
  blocking_reason: z.string().default(""),
  received_at: z.string().nullable().default(null),
}).loose();

const AIMeOnboardingStepSchema = z.object({
  key: z.string().default(""),
  title: z.string().default(""),
  description: z.string().default(""),
  completed: z.boolean().default(false),
}).loose();

export const AIMeOnboardingStatusSchema = z.object({
  completed: z.boolean().default(false),
  completed_steps: z.number().default(0),
  total_steps: z.number().default(0),
  steps: z.array(AIMeOnboardingStepSchema).default([]),
}).loose();

export const EMPTY_AIME_ONBOARDING_STATUS: AIMeOnboardingStatus = {
  completed: false,
  completed_steps: 0,
  total_steps: 0,
  steps: [],
};

export const FeishuDogfoodPanelSchema = z.object({
  status: FeishuIntegrationStatusSchema.default({
    provider: "feishu",
    event_mode: "webhook",
    incoming_configured: false,
    outgoing_configured: false,
    webhook_configured: false,
    signature_configured: false,
    websocket_configured: false,
    workspace_configured: false,
    workspace_matches: false,
    owner_configured: false,
    allowed_chat_configured: false,
    group_message_policy: "mention",
    callback_path: "/api/integrations/feishu/webhook",
    required_events: [],
    required_scopes: [],
    warnings: [],
  }),
  summary: FeishuDogfoodSummarySchema.default({
    total_received: 0,
    received_today: 0,
    approvals_created: 0,
    pending_approval: 0,
    rejected: 0,
    sent: 0,
    send_failed: 0,
    ai_drafted: 0,
    quality_reviewed: 0,
    avg_quality_score: 0,
    dogfood_target: 20,
    dogfood_completed: 0,
    dogfood_remaining: 20,
    first_received_at: null,
    last_received_at: null,
  }),
  cost: AIMeCostControlSchema.default({
    currency: "USD",
    draft_call_count: 0,
    estimated_draft_cost_cents: 0,
    draft_cost_microusd: 0,
    daily_budget_cents: 0,
    daily_budget_microusd: 0,
    remaining_budget_cents: 0,
    remaining_budget_microusd: 0,
    budget_configured: false,
    budget_status: "unconfigured",
    worker_task_count: 0,
    worker_input_tokens: 0,
    worker_output_tokens: 0,
    worker_cache_read_tokens: 0,
    worker_cache_write_tokens: 0,
  }),
  reliability: FeishuReliabilitySummarySchema.default({
    webhook_events: 0,
    duplicate_events: 0,
    accepted_events: 0,
    ignored_events: 0,
    failed_events: 0,
    rejected_events: 0,
    signature_verified_events: 0,
    replay_protected_events: 0,
    events_today: 0,
    last_event_at: null,
  }),
  delivery: FeishuDeliverySummarySchema.default({
    deliveries: 0,
    sending: 0,
    succeeded: 0,
    failed: 0,
    dead_letter: 0,
    attempts: 0,
    last_delivery_at: null,
  }),
  quality: AIMeQualitySummarySchema.default({
    reviewed: 0,
    avg_score: 0,
    good: 0,
    poor: 0,
    accepted: 0,
    needs_retry: 0,
    wrong: 0,
    last_reviewed_at: null,
  }),
  model_route: AIMeModelRoutingSchema.default({
    default_provider: "deepseek",
    default_model: "deepseek-v4-flash",
    draft_provider: "deepseek",
    draft_model: "deepseek-v4-flash",
    worker_policy: "",
    daily_budget_cents: 0,
    budget_status: "ok",
    recommended_next_actions: [],
  }),
  onboarding: AIMeOnboardingStatusSchema.default({
    completed: false,
    completed_steps: 0,
    total_steps: 0,
    steps: [],
  }),
  checklist: z.array(FeishuDogfoodChecklistItemSchema).default([]),
  cases: z.array(FeishuDogfoodCaseSchema).default([]),
  logs: z.array(FeishuMessageLogSchema).default([]),
  events: z.array(FeishuWebhookEventSchema).default([]),
  deliveries: z.array(FeishuDeliverySchema).default([]),
}).loose();

export const EMPTY_FEISHU_DOGFOOD_PANEL: FeishuDogfoodPanel = {
  status: EMPTY_FEISHU_INTEGRATION_STATUS,
  summary: {
    total_received: 0,
    received_today: 0,
    approvals_created: 0,
    pending_approval: 0,
    rejected: 0,
    sent: 0,
    send_failed: 0,
    ai_drafted: 0,
    quality_reviewed: 0,
    avg_quality_score: 0,
    dogfood_target: 20,
    dogfood_completed: 0,
    dogfood_remaining: 20,
    first_received_at: null,
    last_received_at: null,
  },
  cost: {
    currency: "USD",
    draft_call_count: 0,
    estimated_draft_cost_cents: 0,
    draft_cost_microusd: 0,
    daily_budget_cents: 0,
    daily_budget_microusd: 0,
    remaining_budget_cents: 0,
    remaining_budget_microusd: 0,
    budget_configured: false,
    budget_status: "unconfigured",
    worker_task_count: 0,
    worker_input_tokens: 0,
    worker_output_tokens: 0,
    worker_cache_read_tokens: 0,
    worker_cache_write_tokens: 0,
  },
  reliability: {
    webhook_events: 0,
    duplicate_events: 0,
    accepted_events: 0,
    ignored_events: 0,
    failed_events: 0,
    rejected_events: 0,
    signature_verified_events: 0,
    replay_protected_events: 0,
    events_today: 0,
    last_event_at: null,
  },
  delivery: {
    deliveries: 0,
    sending: 0,
    succeeded: 0,
    failed: 0,
    dead_letter: 0,
    attempts: 0,
    last_delivery_at: null,
  },
  quality: {
    reviewed: 0,
    avg_score: 0,
    good: 0,
    poor: 0,
    accepted: 0,
    needs_retry: 0,
    wrong: 0,
    last_reviewed_at: null,
  },
  model_route: {
    default_provider: "deepseek",
    default_model: "deepseek-v4-flash",
    draft_provider: "deepseek",
    draft_model: "deepseek-v4-flash",
    worker_policy: "",
    daily_budget_cents: 0,
    budget_status: "ok",
    recommended_next_actions: [],
  },
  onboarding: EMPTY_AIME_ONBOARDING_STATUS,
  checklist: [],
  cases: [],
  logs: [],
  events: [],
  deliveries: [],
};

export const AIMeCockpitSummarySchema = z.object({
  active_tasks: z.number().default(0),
  queued_tasks: z.number().default(0),
  running_tasks: z.number().default(0),
  completed_tasks_today: z.number().default(0),
  failed_tasks_today: z.number().default(0),
  pending_decisions: z.number().default(0),
  high_risk_pending: z.number().default(0),
  waiting_external: z.number().default(0),
  execution_succeeded: z.number().default(0),
  execution_failed: z.number().default(0),
  external_reply_pending: z.number().default(0),
  assign_worker_succeeded: z.number().default(0),
  external_reply_succeeded: z.number().default(0),
  active_memories: z.number().default(0),
  memory_used_today: z.number().default(0),
  unread_inbox: z.number().default(0),
  active_issues: z.number().default(0),
}).loose();

export const EMPTY_AIME_COCKPIT_SUMMARY: AIMeCockpitSummary = {
  active_tasks: 0,
  queued_tasks: 0,
  running_tasks: 0,
  completed_tasks_today: 0,
  failed_tasks_today: 0,
  pending_decisions: 0,
  high_risk_pending: 0,
  waiting_external: 0,
  execution_succeeded: 0,
  execution_failed: 0,
  external_reply_pending: 0,
  assign_worker_succeeded: 0,
  external_reply_succeeded: 0,
  active_memories: 0,
  memory_used_today: 0,
  unread_inbox: 0,
  active_issues: 0,
};

const AIMeSuggestedActionSchema = z.object({
  type: z.string(),
  title: z.string(),
  description: z.string(),
  target_agent_id: z.string().optional(),
  target_agent_name: z.string().optional(),
  issue_id: z.string().optional(),
  priority: z.string().optional(),
  requires_approval: z.boolean().default(true),
}).loose();

const AIMeEvidenceSchema = z.object({
  type: z.string(),
  label: z.string(),
  ref_id: z.string().optional(),
  quote: z.string().optional(),
}).loose();

const AIMeWorkspaceContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  context: z.string().optional(),
}).loose();

const AIMeIssueContextSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  assignee_type: z.string().optional(),
  assignee_id: z.string().optional(),
}).loose();

const AIMeAgentContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  status: z.string(),
  runtime_status: z.string(),
  model: z.string().optional(),
}).loose();

const AIMeMemoryContextSchema = z.object({
  id: z.string(),
  type: z.string(),
  category: z.string().optional(),
  title: z.string(),
  content: z.string(),
  summary: z.string().optional(),
  confidence: z.number().default(0),
  sensitivity: z.string(),
  scope_type: z.string(),
  external_use_policy: z.string(),
}).loose();

const AIMeContextSummarySchema = z.object({
  workspace: AIMeWorkspaceContextSchema.default({
    id: "",
    name: "",
    slug: "",
  }),
  issues: z.array(AIMeIssueContextSchema).nullish().transform((items) => items ?? []),
  agents: z.array(AIMeAgentContextSchema).nullish().transform((items) => items ?? []),
  memories: z.array(AIMeMemoryContextSchema).nullish().transform((items) => items ?? []),
}).loose();

const AIMePolicyContextSchema = z.object({
  enabled: z.boolean().default(true),
  autonomy_level: z.string().default("balanced"),
  approval_mode: z.string().default("risky"),
  timezone: z.string().default("Asia/Shanghai"),
  working_hours: z.object({
    start: z.string().default("09:00"),
    end: z.string().default("18:00"),
  }).default({ start: "09:00", end: "18:00" }),
  in_working_hours: z.boolean().default(true),
  model_provider: z.string().default("deepseek"),
  model_name: z.string().default("deepseek-v4-flash"),
}).loose();

export const AIMeThinkResponseSchema = z.object({
  id: z.string(),
  mode: z.string(),
  provider: z.string().default(""),
  model: z.string().default(""),
  configured: z.boolean().default(false),
  summary: z.string().default(""),
  risk_level: z.string().default("medium"),
  confidence: z.number().default(0),
  need_approval: z.boolean().default(true),
  approval_id: z.string().optional(),
  approval_ids: z.array(z.string()).optional(),
  reply_draft: z.string().default(""),
  reasoning_summary: z.string().default(""),
  actions: z.array(AIMeSuggestedActionSchema).default([]),
  evidence: z.array(AIMeEvidenceSchema).default([]),
  context: AIMeContextSummarySchema.default({
    workspace: { id: "", name: "", slug: "" },
    issues: [],
    agents: [],
    memories: [],
  }),
  policy: AIMePolicyContextSchema.default({
    enabled: true,
    autonomy_level: "balanced",
    approval_mode: "risky",
    timezone: "Asia/Shanghai",
    working_hours: { start: "09:00", end: "18:00" },
    in_working_hours: true,
    model_provider: "deepseek",
    model_name: "deepseek-v4-flash",
  }),
  configuration_required: z.boolean().default(false),
  error: z.string().optional(),
  created_at: z.string().default(""),
}).loose();

export const EMPTY_AIME_THINK_RESPONSE: AIMeThinkResponse = {
  id: "",
  mode: "fallback",
  provider: "",
  model: "",
  configured: false,
  summary: "",
  risk_level: "medium",
  confidence: 0,
  need_approval: true,
  approval_id: "",
  approval_ids: [],
  reply_draft: "",
  reasoning_summary: "",
  actions: [],
  evidence: [],
  context: {
    workspace: { id: "", name: "", slug: "" },
    issues: [],
    agents: [],
    memories: [],
  },
  policy: {
    enabled: true,
    autonomy_level: "balanced",
    approval_mode: "risky",
    timezone: "Asia/Shanghai",
    working_hours: { start: "09:00", end: "18:00" },
    in_working_hours: true,
    model_provider: "deepseek",
    model_name: "deepseek-v4-flash",
  },
  configuration_required: false,
  created_at: "",
};
