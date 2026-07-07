import type {
  AIApproval,
  Agent,
  AgentTask,
  InboxItem,
  Issue,
  MemoryEntry,
} from "@multica/core/types";

export interface CockpitDecisionItem {
  approval: AIApproval;
  issue: Issue | null;
}

export interface CockpitInboxItem {
  item: InboxItem;
  issue: Issue | null;
}

export interface CockpitWorkItem {
  task: AgentTask;
  agent: Agent | null;
  issue: Issue | null;
}

export interface CockpitQueues {
  decisions: CockpitDecisionItem[];
  inbox: CockpitInboxItem[];
  activeWork: CockpitWorkItem[];
  memoryCandidates: MemoryEntry[];
}

export interface BuildCockpitQueuesInput {
  approvals: AIApproval[];
  inboxItems: InboxItem[];
  tasks: AgentTask[];
  agents: Agent[];
  issues: Issue[];
  memories: MemoryEntry[];
}

const ACTIVE_TASK_STATUSES = new Set<AgentTask["status"]>([
  "queued",
  "dispatched",
  "running",
]);

export function buildCockpitQueues(input: BuildCockpitQueuesInput): CockpitQueues {
  const issueById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const agentById = new Map(input.agents.map((agent) => [agent.id, agent]));

  return {
    decisions: input.approvals
      .filter((approval) => approval.status === "pending")
      .sort(compareApprovals)
      .map((approval) => ({
        approval,
        issue: approval.issue_id ? issueById.get(approval.issue_id) ?? null : null,
      })),
    inbox: input.inboxItems
      .filter((item) => !item.archived)
      .sort(compareInboxItems)
      .map((item) => ({
        item,
        issue: item.issue_id ? issueById.get(item.issue_id) ?? null : null,
      })),
    activeWork: input.tasks
      .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
      .sort(compareActiveTasks)
      .map((task) => ({
        task,
        agent: agentById.get(task.agent_id) ?? null,
        issue: task.issue_id ? issueById.get(task.issue_id) ?? null : null,
      })),
    memoryCandidates: input.memories
      .filter((memory) => memory.status === "candidate")
      .sort((a, b) => timestamp(b.updated_at) - timestamp(a.updated_at)),
  };
}

export function formatDashboardAge(value: string | null | undefined, now = Date.now()): string {
  const ts = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ts)) return "刚刚";
  const minutes = Math.max(1, Math.round((now - ts) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

export function describeDashboardTask(task: AgentTask, issue: Issue | null): string {
  if (issue) return `${issue.identifier} ${issue.title}`;
  if (task.trigger_summary) return task.trigger_summary;
  if (task.chat_session_id) return "聊天任务";
  if (task.autopilot_run_id) return "自动驾驶任务";
  if (task.kind === "quick_create") return "快速创建任务";
  return `任务 ${task.id.slice(0, 8)}`;
}

export function taskProgressPercent(status: AgentTask["status"]): number {
  switch (status) {
    case "running":
      return 72;
    case "dispatched":
      return 44;
    case "queued":
      return 18;
    default:
      return 0;
  }
}

function compareApprovals(a: AIApproval, b: AIApproval): number {
  return riskRank(a.risk_level) - riskRank(b.risk_level) ||
    timestamp(b.created_at) - timestamp(a.created_at);
}

function compareInboxItems(a: InboxItem, b: InboxItem): number {
  return severityRank(a.severity) - severityRank(b.severity) ||
    Number(a.read) - Number(b.read) ||
    timestamp(b.created_at) - timestamp(a.created_at);
}

function compareActiveTasks(a: AgentTask, b: AgentTask): number {
  return taskStatusRank(a.status) - taskStatusRank(b.status) ||
    taskTime(b) - taskTime(a);
}

function riskRank(value: string): number {
  if (value === "high") return 0;
  if (value === "medium") return 1;
  if (value === "low") return 2;
  return 3;
}

function severityRank(value: string): number {
  if (value === "action_required") return 0;
  if (value === "attention") return 1;
  if (value === "info") return 2;
  return 3;
}

function taskStatusRank(value: AgentTask["status"]): number {
  if (value === "running") return 0;
  if (value === "dispatched") return 1;
  if (value === "queued") return 2;
  return 3;
}

function taskTime(task: AgentTask): number {
  return timestamp(task.started_at ?? task.dispatched_at ?? task.created_at);
}

function timestamp(value: string | null | undefined): number {
  const ts = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}
