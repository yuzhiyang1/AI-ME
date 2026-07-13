import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AIApproval, AIApprovalStats } from "@multica/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCenterPage } from "./approval-center-page";

const mockNavigation = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  listAIApprovals: vi.fn(),
  getAIApprovalStats: vi.fn(),
  getAIApproval: vi.fn(),
  approveAIApproval: vi.fn(),
  rejectAIApproval: vi.fn(),
  observeAIApproval: vi.fn(),
  takeOverAIApproval: vi.fn(),
  listTasksByIssue: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    approvals: (id?: string) => (id ? `/test/approvals?approval=${id}` : "/test/approvals"),
    inbox: (opts?: { inboxItemId?: string }) =>
      opts?.inboxItemId ? `/test/inbox?inbox=${opts.inboxItemId}` : "/test/inbox",
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getAgentName: () => "Codex Worker",
  }),
}));

vi.mock("@multica/ui/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
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
  useNavigation: () => ({
    searchParams: mockNavigation.searchParams,
    replace: mockNavigation.replace,
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("ApprovalCenterPage edit then approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigation.searchParams = new URLSearchParams();

    const approval = makeApproval({
      final_payload: {
        channel: "feishu",
        message_id: "msg-1",
        text: "您好，退款申请已经收到，我会继续跟进。",
      },
    });

    mockApi.listAIApprovals.mockResolvedValue({ approvals: [approval], total: 1 });
    mockApi.getAIApproval.mockResolvedValue(approval);
    mockApi.getAIApprovalStats.mockResolvedValue(makeStats());
    mockApi.approveAIApproval.mockImplementation((_id: string, data: unknown) =>
      Promise.resolve({
        ...approval,
        status: "approved",
        final_payload: data && typeof data === "object" && "final_payload" in data
          ? (data as { final_payload: unknown }).final_payload
          : approval.final_payload,
      }),
    );
    mockApi.rejectAIApproval.mockResolvedValue(approval);
    mockApi.observeAIApproval.mockResolvedValue(approval);
    mockApi.takeOverAIApproval.mockResolvedValue(approval);
    mockApi.listTasksByIssue.mockResolvedValue([]);
    mockApi.rerunIssue.mockResolvedValue({});
  });

  it("submits edited reply text as final payload while preserving metadata", async () => {
    renderApprovals();

    expect(await screen.findByText("是否对外回复退款问题")).toBeInTheDocument();
    const editButton = screen.getByRole("button", { name: "编辑后批准" });
    expect(editButton).not.toBeDisabled();
    fireEvent.click(editButton);

    fireEvent.change(await screen.findByLabelText("编辑后发送内容"), {
      target: { value: "您好，退款申请已加急处理，预计 1 个工作日内更新结果。" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存并批准/ }));

    await waitFor(() => {
      expect(mockApi.approveAIApproval).toHaveBeenCalledWith("approval-1", {
        note: "编辑后批准",
        final_payload: {
          channel: "feishu",
          message_id: "msg-1",
          text: "您好，退款申请已加急处理，预计 1 个工作日内更新结果。",
        },
      });
    });
  });

  it("shows failed execution result, event payload, and evidence", async () => {
    const failedApproval = makeApproval({
      status: "approved",
      execution_status: "failed",
      execution_error: "feishu client is not configured",
      evidence: [
        {
          id: "evidence-1",
          approval_id: "approval-1",
          workspace_id: "ws-1",
          evidence_type: "log",
          label: "执行失败",
          ref_id: "msg-1",
          source_url: null,
          quote: "feishu client is not configured",
          metadata: {
            execution_status: "failed",
            execution_error: "feishu client is not configured",
            channel: "feishu",
            message_id: "msg-1",
          },
          created_at: "2026-07-08T02:05:00.000Z",
        },
      ],
      events: [
        {
          id: "event-1",
          approval_id: "approval-1",
          workspace_id: "ws-1",
          actor_type: "member",
          actor_id: "member-1",
          event_type: "execution_failed",
          from_status: "approved",
          to_status: "approved",
          payload: {
            execution_status: "failed",
            execution_error: "feishu client is not configured",
            channel: "feishu",
            message_id: "msg-1",
          },
          created_at: "2026-07-08T02:06:00.000Z",
        },
      ],
    });
    mockApi.listAIApprovals.mockResolvedValue({ approvals: [failedApproval], total: 1 });
    mockApi.getAIApproval.mockResolvedValue(failedApproval);

    renderApprovals();

    expect(await screen.findByText("是否对外回复退款问题")).toBeInTheDocument();
    expect(screen.getAllByText("执行失败").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/feishu client is not configured/).length).toBeGreaterThan(0);
    expect(await screen.findByText(/状态：失败/)).toHaveTextContent("渠道：feishu");
    expect(screen.getByText(/状态：失败/)).toHaveTextContent("消息：msg-1");
  });

  it("disables external approval while the employee task result is pending", async () => {
    const waitingApproval = makeApproval({
      summary: "Codex Worker 正在处理工作项。",
      final_payload: {
        channel: "feishu",
        message_id: "msg-1",
        text: "已创建工作项，正在处理。",
        awaiting_task_result: true,
        task_id: "task-1",
      },
      created_task_id: "task-1",
      events: [
        {
          id: "event-waiting-task",
          approval_id: "approval-1",
          workspace_id: "ws-1",
          actor_type: "ai_me",
          actor_id: "member-1",
          event_type: "edited",
          from_status: "pending",
          to_status: "pending",
          payload: {
            kind: "task_result_waiting",
            task_id: "task-1",
            issue_id: "issue-1",
            continuation_depth: 1,
          },
          created_at: "2026-07-13T04:00:00.000Z",
        },
      ],
    });
    mockApi.listAIApprovals.mockResolvedValue({ approvals: [waitingApproval], total: 1 });
    mockApi.getAIApproval.mockResolvedValue(waitingApproval);

    renderApprovals();

    expect(await screen.findByText("等待员工执行结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准并发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑后批准" })).toBeDisabled();
    expect(screen.getByText("等待员工结果")).toBeInTheDocument();
    expect(screen.getByText(/任务：task-1/)).toHaveTextContent("工作项：issue-1");
    expect(screen.getByText(/任务：task-1/)).toHaveTextContent("续跑：第 1 层");
  });
});

function renderApprovals() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ApprovalCenterPage />
    </QueryClientProvider>,
  );
}

function makeStats(): AIApprovalStats {
  return {
    total: 1,
    pending: 1,
    high_risk_pending: 1,
    observing: 0,
    approved: 0,
    rejected: 0,
    taken_over: 0,
    expired: 0,
    succeeded: 0,
    failed: 0,
  };
}

function makeApproval(overrides: Partial<AIApproval> = {}): AIApproval {
  return {
    id: "approval-1",
    workspace_id: "ws-1",
    requester_user_id: null,
    source_type: "external_message",
    source_ref_id: "msg-1",
    source_url: null,
    issue_id: null,
    inbox_item_id: "inbox-1",
    task_queue_id: null,
    memory_id: null,
    title: "是否对外回复退款问题",
    summary: "AI-Me 已生成退款回复草稿，需要你批准后发送。",
    status: "pending",
    risk_level: "high",
    confidence: 0.92,
    reversibility: "compensatable",
    action_type: "send_external_message",
    action_title: "发送飞书回复",
    action_description: "批准后将回复发送到原飞书消息。",
    original_payload: {
      channel: "feishu",
      message_id: "msg-1",
      text: "用户询问退款进度。",
    },
    final_payload: {
      channel: "feishu",
      message_id: "msg-1",
      text: "您好，退款申请已经收到，我会继续跟进。",
    },
    ai_reasoning_summary: "涉及退款承诺，需要人工确认语气和时效。",
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
    evidence: [],
    events: [],
    ...overrides,
  };
}
