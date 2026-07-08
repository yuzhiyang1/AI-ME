import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AIApproval, AgentTask, TimelineEntry } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";
import { AIMeWorkTrace } from "./ai-me-work-trace";

const mockApi = vi.hoisted(() => ({
  listTasksByIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getAgentName: (id: string) => (id === "agent-1" ? "Codex Worker" : "Agent"),
    getActorName: (type: string, id: string) => `${type}:${id}`,
  }),
}));

vi.mock("@multica/core/utils", () => ({
  timeAgo: () => "just now",
}));

function approval(patch: Partial<AIApproval> = {}): AIApproval {
  return {
    id: "approval-1",
    workspace_id: "ws-1",
    requester_user_id: "user-1",
    source_type: "issue",
    source_ref_id: "issue-1",
    source_url: null,
    issue_id: "issue-1",
    inbox_item_id: null,
    task_queue_id: null,
    memory_id: null,
    title: "Assign Codex worker",
    summary: "",
    status: "pending",
    risk_level: "medium",
    confidence: 0.8,
    reversibility: "reversible",
    action_type: "assign_worker",
    action_title: "Assign worker",
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

function task(patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

function renderTrace({
  approvals = [approval()],
  timeline = [],
  onOpenApproval = vi.fn(),
}: {
  approvals?: AIApproval[];
  timeline?: TimelineEntry[];
  onOpenApproval?: (id: string) => void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, issues: enIssues } }}>
      <QueryClientProvider client={queryClient}>
        <AIMeWorkTrace
          issueId="issue-1"
          approvals={approvals}
          approvalsLoading={false}
          approvalsError={null}
          timeline={timeline}
          onOpenApproval={onOpenApproval}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("AIMeWorkTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listTasksByIssue.mockResolvedValue([task()]);
  });

  it("shows approvals, active worker runs, and attention counts", async () => {
    renderTrace();

    expect(screen.getByText("AI-Me trace")).toBeInTheDocument();
    expect(screen.getByText("Assign Codex worker")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Codex Worker")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
  });

  it("opens the selected approval", async () => {
    const onOpenApproval = vi.fn();
    renderTrace({ onOpenApproval });

    fireEvent.click(screen.getByText("Assign Codex worker"));

    expect(onOpenApproval).toHaveBeenCalledWith("approval-1");
  });

  it("renders an empty state when AI-Me has no trace data", async () => {
    mockApi.listTasksByIssue.mockResolvedValue([]);
    renderTrace({ approvals: [] });

    await waitFor(() => {
      expect(
        screen.getByText("AI-Me has not created approvals or worker runs for this issue yet."),
      ).toBeInTheDocument();
    });
  });
});
