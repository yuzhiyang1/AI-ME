import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import type { AgentTask } from "@multica/core/types";
import { AgentTaskRunList } from "./agent-task-run-list";

const mockApi = vi.hoisted(() => ({
  cancelTask: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

vi.mock("../actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">{actorType}:{actorId}</span>
  ),
}));

vi.mock("../task-transcript", () => ({
  TranscriptButton: ({ title }: { title: string }) => (
    <button type="button" aria-label={title}>
      transcript
    </button>
  ),
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({
    render,
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    render?: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  }) => {
    const renderProps =
      render && typeof render.props === "object" ? render.props : {};
    return (
      <button type="button" {...renderProps} {...props}>
        {children}
      </button>
    );
  },
}));

describe("AgentTaskRunList", () => {
  beforeEach(() => {
    mockApi.cancelTask.mockReset();
    mockApi.rerunIssue.mockReset();
    mockApi.cancelTask.mockResolvedValue(task({ status: "cancelled" }));
    mockApi.rerunIssue.mockResolvedValue(task({ status: "queued" }));
  });

  it("renders an explicit empty state when requested", () => {
    render(<AgentTaskRunList tasks={[]} showEmpty />);

    expect(screen.getByText("No agent runs")).toBeInTheDocument();
    expect(screen.getByText("Agent execution records will appear here.")).toBeInTheDocument();
  });

  it("hides destructive actions when no issue id is available", () => {
    render(
      <AgentTaskRunList
        tasks={[
          task({ id: "running", status: "running", started_at: "2026-07-08T02:00:00.000Z" }),
          task({ id: "failed", status: "failed", completed_at: "2026-07-08T03:00:00.000Z" }),
        ]}
        initialShowPast
      />,
    );

    expect(screen.getAllByLabelText("View transcript")).toHaveLength(2);
    expect(screen.queryByLabelText("Cancel task")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Retry task")).not.toBeInTheDocument();
  });

  it("cancels active tasks through the issue-scoped API", () => {
    render(
      <AgentTaskRunList
        tasks={[task({ id: "running", status: "running", started_at: "2026-07-08T02:00:00.000Z" })]}
        issueId="issue-1"
      />,
    );

    fireEvent.click(screen.getByLabelText("Cancel task"));

    expect(mockApi.cancelTask).toHaveBeenCalledWith("issue-1", "running");
  });

  it("reruns failed past tasks through the issue-scoped API", () => {
    render(
      <AgentTaskRunList
        tasks={[task({ id: "failed", status: "failed", completed_at: "2026-07-08T03:00:00.000Z" })]}
        issueId="issue-1"
        initialShowPast
      />,
    );

    fireEvent.click(screen.getByLabelText("Retry task"));

    expect(mockApi.rerunIssue).toHaveBeenCalledWith("issue-1");
  });

  it("supports agent-scoped cancellation without an issue id", () => {
    const onCancelTask = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentTaskRunList
        tasks={[task({ id: "running", status: "running", started_at: "2026-07-08T02:00:00.000Z" })]}
        onCancelTask={onCancelTask}
      />,
    );

    fireEvent.click(screen.getByLabelText("Cancel task"));

    expect(onCancelTask).toHaveBeenCalledWith(expect.objectContaining({ id: "running" }));
    expect(mockApi.cancelTask).not.toHaveBeenCalled();
  });

  it("can render past runs without the collapse toggle", () => {
    render(
      <AgentTaskRunList
        tasks={[task({ id: "failed", status: "failed", completed_at: "2026-07-08T03:00:00.000Z" })]}
        collapsePast={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Show past runs (1)" })).not.toBeInTheDocument();
    expect(screen.getByText("Initial assignment")).toBeInTheDocument();
  });
});

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
