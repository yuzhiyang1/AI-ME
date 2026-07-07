import { describe, expect, it } from "vitest";
import type {
  AIApproval,
  Agent,
  AgentTask,
  InboxItem,
  Issue,
  MemoryEntry,
} from "@multica/core/types";
import {
  buildCockpitQueues,
  describeDashboardTask,
  formatDashboardAge,
  taskProgressPercent,
} from "./dashboard-data";

const wsId = "workspace-1";

describe("buildCockpitQueues", () => {
  it("prioritizes pending approvals by risk then newest first", () => {
    const queues = buildCockpitQueues({
      approvals: [
        approval({ id: "low-new", risk_level: "low", created_at: "2026-07-07T11:00:00.000Z" }),
        approval({ id: "high-old", risk_level: "high", created_at: "2026-07-07T09:00:00.000Z" }),
        approval({ id: "done", status: "approved", risk_level: "high" }),
        approval({ id: "high-new", risk_level: "high", created_at: "2026-07-07T10:00:00.000Z" }),
      ],
      inboxItems: [],
      tasks: [],
      agents: [],
      issues: [],
      memories: [],
    });

    expect(queues.decisions.map((item) => item.approval.id)).toEqual([
      "high-new",
      "high-old",
      "low-new",
    ]);
  });

  it("sorts inbox items by severity, unread state, and recency", () => {
    const queues = buildCockpitQueues({
      approvals: [],
      inboxItems: [
        inbox({ id: "attention-new", severity: "attention", created_at: "2026-07-07T11:00:00.000Z" }),
        inbox({ id: "action-read", severity: "action_required", read: true, created_at: "2026-07-07T12:00:00.000Z" }),
        inbox({ id: "action-unread", severity: "action_required", created_at: "2026-07-07T10:00:00.000Z" }),
        inbox({ id: "archived", archived: true, severity: "action_required" }),
      ],
      tasks: [],
      agents: [],
      issues: [],
      memories: [],
    });

    expect(queues.inbox.map((item) => item.item.id)).toEqual([
      "action-unread",
      "action-read",
      "attention-new",
    ]);
  });

  it("joins active tasks to agents and issues", () => {
    const agent = worker({ id: "agent-1", name: "Codex Worker" });
    const issue = issueRow({ id: "issue-1", identifier: "MUL-170", title: "退款问题" });
    const queues = buildCockpitQueues({
      approvals: [],
      inboxItems: [],
      tasks: [
        task({ id: "task-done", status: "completed", agent_id: agent.id, issue_id: issue.id }),
        task({ id: "task-running", status: "running", agent_id: agent.id, issue_id: issue.id }),
      ],
      agents: [agent],
      issues: [issue],
      memories: [],
    });

    expect(queues.activeWork).toHaveLength(1);
    expect(queues.activeWork[0]?.agent?.name).toBe("Codex Worker");
    expect(describeDashboardTask(queues.activeWork[0]!.task, queues.activeWork[0]!.issue)).toBe(
      "MUL-170 退款问题",
    );
    expect(taskProgressPercent("running")).toBeGreaterThan(taskProgressPercent("queued"));
  });

  it("keeps only candidate memories and formats relative age", () => {
    const queues = buildCockpitQueues({
      approvals: [],
      inboxItems: [],
      tasks: [],
      agents: [],
      issues: [],
      memories: [
        memory({ id: "active", status: "active" }),
        memory({ id: "candidate-old", updated_at: "2026-07-06T10:00:00.000Z" }),
        memory({ id: "candidate-new", updated_at: "2026-07-07T10:00:00.000Z" }),
      ],
    });

    expect(queues.memoryCandidates.map((item) => item.id)).toEqual([
      "candidate-new",
      "candidate-old",
    ]);
    expect(formatDashboardAge("2026-07-07T09:30:00.000Z", new Date("2026-07-07T10:00:00.000Z").getTime())).toBe(
      "30 分钟前",
    );
  });
});

function approval(overrides: Partial<AIApproval> = {}): AIApproval {
  return {
    id: "approval-1",
    workspace_id: wsId,
    requester_user_id: null,
    source_type: "ai_me_think",
    source_ref_id: null,
    source_url: null,
    issue_id: null,
    inbox_item_id: null,
    task_queue_id: null,
    memory_id: null,
    title: "需要审批",
    summary: "需要用户确认后继续。",
    status: "pending",
    risk_level: "medium",
    confidence: 0.85,
    reversibility: "reversible",
    action_type: "assign_worker",
    action_title: "分配员工",
    action_description: "把任务交给 AI 员工。",
    original_payload: null,
    final_payload: null,
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
    created_at: "2026-07-07T10:00:00.000Z",
    updated_at: "2026-07-07T10:00:00.000Z",
    ...overrides,
  };
}

function inbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: wsId,
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: null,
    title: "新消息",
    body: "需要查看。",
    issue_status: "todo",
    read: false,
    archived: false,
    created_at: "2026-07-07T10:00:00.000Z",
    details: null,
    ...overrides,
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "",
    status: "queued",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-07-07T10:00:00.000Z",
    ...overrides,
  };
}

function worker(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    workspace_id: wsId,
    runtime_id: "runtime-1",
    name: "Worker",
    description: "",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_env: {},
    custom_args: [],
    custom_env_redacted: false,
    visibility: "workspace",
    status: "idle",
    max_concurrent_tasks: 1,
    model: "",
    owner_id: null,
    skills: [],
    created_at: "2026-07-07T10:00:00.000Z",
    updated_at: "2026-07-07T10:00:00.000Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function issueRow(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: wsId,
    number: 1,
    identifier: "MUL-1",
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    due_date: null,
    created_at: "2026-07-07T10:00:00.000Z",
    updated_at: "2026-07-07T10:00:00.000Z",
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "memory-1",
    workspace_id: wsId,
    owner_user_id: null,
    project_id: null,
    type: "preference",
    category: "user",
    title: "用户偏好",
    content: "偏好中文沟通。",
    summary: "偏好中文沟通。",
    status: "candidate",
    confidence: 0.9,
    sensitivity: "normal",
    scope_type: "workspace",
    scope_ref_id: null,
    external_use_policy: "with_approval",
    source_mode: "inferred",
    created_by_type: "ai",
    created_by_id: null,
    verified_by: null,
    verified_at: null,
    last_used_at: null,
    expires_at: null,
    archived_at: null,
    created_at: "2026-07-07T10:00:00.000Z",
    updated_at: "2026-07-07T10:00:00.000Z",
    ...overrides,
  };
}
