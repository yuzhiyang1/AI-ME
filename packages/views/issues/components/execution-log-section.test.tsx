import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AgentTask } from "@multica/core/types";
import { issueKeys } from "@multica/core/issues/queries";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import { ExecutionLogSection } from "./execution-log-section";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const mockApi = vi.hoisted(() => ({
  listTasksByIssue: vi.fn(),
  cancelTask: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

vi.mock("@multica/core/utils", () => ({
  timeAgo: () => "1m ago",
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">
      {actorType}:{actorId}
    </span>
  ),
}));

vi.mock("../../common/task-transcript", () => ({
  TranscriptButton: ({ title }: { title: string }) => (
    <button type="button" aria-label={title}>
      transcript
    </button>
  ),
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ render, children, ...props }: any) => {
    if (isValidElement(render)) {
      return cloneElement(render, props, children);
    }
    return (
      <button type="button" {...props}>
        {children}
      </button>
    );
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("ExecutionLogSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.cancelTask.mockResolvedValue(task({ id: "running", status: "cancelled" }));
    mockApi.rerunIssue.mockResolvedValue(task({ id: "rerun", status: "queued" }));
  });

  it("uses the issue task cache and keeps transcript, cancel, and retry actions", async () => {
    const tasks = [
      task({ id: "running", status: "running", started_at: "2026-07-08T03:00:00.000Z" }),
      task({ id: "failed", status: "failed", completed_at: "2026-07-08T02:00:00.000Z" }),
    ];
    mockApi.listTasksByIssue.mockResolvedValue(tasks);
    const queryClient = createQueryClient();

    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <ExecutionLogSection issueId="issue-1" />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(mockApi.listTasksByIssue).toHaveBeenCalledWith("issue-1");
    });
    expect(queryClient.getQueryData(issueKeys.tasks("issue-1"))).toEqual(tasks);
    expect(await screen.findByText("Execution log")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Initial run")).toBeInTheDocument();
    expect(screen.getByLabelText("View transcript")).toBeInTheDocument();
    expect(screen.getByLabelText("Cancel task")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show past runs (1)"));

    expect(screen.getAllByLabelText("View transcript")).toHaveLength(2);
    expect(screen.getByLabelText("Retry task")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Cancel task"));
    expect(mockApi.cancelTask).toHaveBeenCalledWith("issue-1", "running");

    fireEvent.click(screen.getByLabelText("Retry task"));
    expect(mockApi.rerunIssue).toHaveBeenCalledWith("issue-1");
  });
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
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
