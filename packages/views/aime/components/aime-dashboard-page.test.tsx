import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AIApproval,
  Agent,
  AgentTask,
  InboxItem,
  Issue,
  MemoryEntry,
} from "@multica/core/types";
import { AIMeDashboardPage } from "./aime-dashboard-page";

const mockThink = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
  data: null,
  error: null,
}));

const mockApi = vi.hoisted(() => ({
  getAIMeCockpitSummary: vi.fn(),
  listAIApprovals: vi.fn(),
  listInbox: vi.fn(),
  getAgentTaskSnapshot: vi.fn(),
  listMemoryEntries: vi.fn(),
  listAgents: vi.fn(),
  listIssues: vi.fn(),
  listTasksByIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    approvals: (id?: string) => (id ? `/test/approvals/${id}` : "/test/approvals"),
    issueDetail: (id: string) => `/test/issues/${id}`,
    inbox: (opts?: { inboxItemId?: string }) =>
      opts?.inboxItemId ? `/test/inbox/${opts.inboxItemId}` : "/test/inbox",
    agents: () => "/test/agents",
    memory: () => "/test/memory",
  }),
}));

vi.mock("@multica/core/aime", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/aime")>(
    "@multica/core/aime",
  );
  return {
    ...actual,
    useThinkAIMe: () => mockThink,
  };
});

vi.mock("@multica/ui/components/ui/alert", () => ({
  Alert: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div role="alert" {...props}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertTitle: ({ children }: { children: React.ReactNode }) => <strong>{children}</strong>,
}));

vi.mock("@multica/ui/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { showCloseButton?: boolean }) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
}));

vi.mock("@multica/ui/components/ui/native-select", () => ({
  NativeSelect: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <select {...props}>{children}</select>
  ),
  NativeSelectOption: ({ children, ...props }: React.OptionHTMLAttributes<HTMLOptionElement>) => (
    <option {...props}>{children}</option>
  ),
}));

vi.mock("@multica/ui/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

vi.mock("@multica/ui/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock("../../layout/page-header", () => ({
  PageHeader: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <header {...props}>{children}</header>
  ),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../../common/agent-task-runs", () => ({
  AgentTaskRunList: ({
    tasks,
    issueId,
  }: {
    tasks: AgentTask[];
    issueId?: string;
  }) => (
    <div data-testid="agent-task-run-list" data-issue-id={issueId ?? ""}>
      {tasks.map((task) => (
        <span key={task.id}>{task.id}</span>
      ))}
    </div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("AIMeDashboardPage work detail drawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThink.isPending = false;
    mockThink.data = null;
    mockThink.error = null;

    mockApi.getAIMeCockpitSummary.mockResolvedValue({
      completed_tasks_today: 1,
      failed_tasks_today: 0,
      active_tasks: 2,
      queued_tasks: 0,
      running_tasks: 2,
      waiting_external: 1,
      unread_inbox: 1,
      pending_decisions: 1,
      external_reply_pending: 1,
      high_risk_pending: 1,
      active_issues: 1,
      execution_succeeded: 3,
      execution_failed: 1,
      assign_worker_succeeded: 1,
      external_reply_succeeded: 1,
      active_memories: 2,
      memory_used_today: 1,
    });
    mockApi.listAIApprovals.mockResolvedValue({
      approvals: [
        approval({
          id: "approval-1",
          issue_id: "issue-1",
          title: "审批退款问题",
          action_title: "给客户回复",
          evidence: [
            {
              id: "evidence-1",
              approval_id: "approval-1",
              workspace_id: "ws-1",
              evidence_type: "message",
              label: "原始消息",
              ref_id: "message-1",
              metadata: null,
              quote: "客户要求退款。",
              source_url: "",
              created_at: "2026-07-08T02:00:00.000Z",
            },
          ],
        }),
      ],
      total: 1,
    });
    mockApi.listInbox.mockResolvedValue([
      inbox({
        id: "inbox-1",
        issue_id: "issue-1",
        title: "客户退款消息",
        body: "客户追问退款进度。",
        severity: "action_required",
        details: {
          approval_id: "approval-inbox-1",
          thread_id: "thread-1",
          source: "feishu",
          reply_preview: "您好，退款问题我已经收到。",
        },
      }),
    ]);
    mockApi.getAgentTaskSnapshot.mockResolvedValue([
      task({
        id: "task-linked",
        issue_id: "issue-1",
        status: "running",
        started_at: "2026-07-08T03:00:00.000Z",
        trigger_summary: "正在分析退款流程",
      }),
      task({
        id: "task-floating",
        issue_id: "",
        status: "running",
        started_at: "2026-07-08T04:00:00.000Z",
        chat_session_id: "chat-1",
      }),
    ]);
    mockApi.listMemoryEntries.mockResolvedValue({ memories: [memory()], total: 1 });
    mockApi.listAgents.mockResolvedValue([worker()]);
    mockApi.listIssues.mockImplementation((params: { status?: string } = {}) =>
      Promise.resolve({
        issues: params.status === "in_progress" ? [issue()] : [],
        total: params.status === "in_progress" ? 1 : 0,
      }),
    );
    mockApi.listTasksByIssue.mockResolvedValue([
      task({
        id: "task-from-issue-query",
        issue_id: "issue-1",
        status: "running",
        started_at: "2026-07-08T03:00:00.000Z",
      }),
    ]);
  });

  it("opens decision, active-work, and inbox detail drawers with evidence and task context", async () => {
    renderDashboard();

    await screen.findByText("审批退款问题");

    openDetailNear("审批退款问题");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("当前判断")).toBeInTheDocument();
    expect(screen.getByText("员工运行")).toBeInTheDocument();
    expect(screen.getByText("证据与来源")).toBeInTheDocument();
    expect(screen.getByText("建议动作")).toBeInTheDocument();
    expect(screen.getByText("给客户回复")).toBeInTheDocument();
    expect(screen.getByText("原始消息")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.listTasksByIssue).toHaveBeenCalledWith("issue-1");
    });
    expect(await screen.findByText("task-from-issue-query")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-run-list")).toHaveAttribute(
      "data-issue-id",
      "issue-1",
    );

    closeDrawer();
    openDetailNear("聊天任务");
    expect(screen.getAllByText("task-floating").length).toBeGreaterThan(0);
    expect(screen.getByTestId("agent-task-run-list")).toHaveAttribute("data-issue-id", "");
    expect(screen.getByText("详细执行证据会从运行记录进入 transcript 查看。")).toBeInTheDocument();

    closeDrawer();
    openDetailNear("客户退款消息");
    expect(screen.getByText("原始事件")).toBeInTheDocument();
    expect(screen.getByText("新评论")).toBeInTheDocument();
    expect(screen.getByText("关联审批")).toBeInTheDocument();
    expect(screen.getAllByText("approval-inbox-1").length).toBeGreaterThan(0);
    expect(screen.getByText("thread_id")).toBeInTheDocument();
    expect(screen.getByText("thread-1")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: /去审批/ })).toHaveAttribute(
      "href",
      "/test/approvals/approval-inbox-1",
    );
  });
});

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AIMeDashboardPage />
    </QueryClientProvider>,
  );
}

function openDetailNear(text: string) {
  for (const node of screen.getAllByText(text)) {
    let current: HTMLElement | null = node;
    while (current) {
      const button = within(current).queryByRole("button", { name: "查看详情" });
      if (button) {
        fireEvent.click(button);
        return;
      }
      current = current.parentElement;
    }
  }
  throw new Error(`No detail button found near ${text}`);
}

function closeDrawer() {
  fireEvent.click(screen.getByLabelText("关闭工作详情"));
}

function approval(overrides: Partial<AIApproval> = {}): AIApproval {
  return {
    id: "approval-1",
    workspace_id: "ws-1",
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
    risk_level: "high",
    confidence: 0.92,
    reversibility: "reversible",
    action_type: "draft_reply",
    action_title: "生成回复",
    action_description: "生成客户回复。",
    original_payload: null,
    final_payload: null,
    ai_reasoning_summary: "退款金额较高，需要确认后回复。",
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
    created_at: "2026-07-08T02:00:00.000Z",
    updated_at: "2026-07-08T02:00:00.000Z",
    ...overrides,
  };
}

function inbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
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
    created_at: "2026-07-08T02:05:00.000Z",
    details: null,
    ...overrides,
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "queued",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-07-08T01:00:00.000Z",
    ...overrides,
  };
}

function worker(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "runtime-1",
    name: "Codex Worker",
    description: "代码员工",
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
    model: "codex",
    owner_id: null,
    skills: [],
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    workspace_id: "ws-1",
    number: 170,
    identifier: "MUL-170",
    title: "退款问题",
    description: null,
    status: "in_progress",
    priority: "high",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    due_date: null,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "memory-1",
    workspace_id: "ws-1",
    owner_user_id: null,
    project_id: null,
    type: "preference",
    category: "user",
    title: "沟通偏好",
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
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}
