import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Agent, AgentRuntime, SkillSummary, AIApprovalStats } from "@multica/core/types";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhTools from "../../locales/zh-Hans/tools.json";
import { ToolsPermissionsPage } from "./tools-permissions-page";

const mockApi = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listRuntimes: vi.fn(),
  listSkills: vi.fn(),
  getAIApprovalStats: vi.fn(),
  getFeishuIntegrationStatus: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function agent(): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "runtime-1",
    name: "Codex Worker",
    description: "",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_env: {},
    custom_args: [],
    custom_env_redacted: true,
    visibility: "workspace",
    status: "idle",
    max_concurrent_tasks: 1,
    model: "",
    owner_id: "user-1",
    skills: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
  };
}

function runtime(): AgentRuntime {
  return {
    id: "runtime-1",
    workspace_id: "ws-1",
    daemon_id: null,
    name: "Local Codex",
    runtime_mode: "local",
    provider: "codex",
    launch_header: "",
    status: "online",
    device_info: "",
    metadata: {},
    owner_id: "user-1",
    last_seen_at: "2026-01-02T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
}

function skill(): SkillSummary {
  return {
    id: "skill-1",
    workspace_id: "ws-1",
    name: "AI-Me UI",
    description: "",
    config: {},
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const stats: AIApprovalStats = {
  total: 3,
  pending: 1,
  high_risk_pending: 0,
  observing: 0,
  approved: 1,
  rejected: 0,
  taken_over: 0,
  expired: 0,
  succeeded: 1,
  failed: 1,
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <I18nProvider locale="zh-Hans" resources={{ "zh-Hans": { common: zhCommon, tools: zhTools } }}>
      <QueryClientProvider client={queryClient}>
        <ToolsPermissionsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("ToolsPermissionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listAgents.mockResolvedValue([agent()]);
    mockApi.listRuntimes.mockResolvedValue([runtime()]);
    mockApi.listSkills.mockResolvedValue([skill()]);
    mockApi.getAIApprovalStats.mockResolvedValue(stats);
    mockApi.getFeishuIntegrationStatus.mockResolvedValue({
      provider: "feishu",
      event_mode: "webhook",
      incoming_configured: true,
      outgoing_configured: true,
      webhook_configured: true,
      websocket_configured: false,
      workspace_configured: true,
      workspace_matches: true,
      owner_configured: true,
      allowed_chat_configured: true,
      group_message_policy: "mention",
      callback_path: "/api/integrations/feishu/webhook",
      required_events: ["im.message.receive_v1"],
      required_scopes: ["im:message:receive_as_bot", "im:message:send_as_bot"],
      warnings: [],
    });
  });

  it("renders tool policies from real workspace resources", async () => {
    renderPage();

    expect(await screen.findByText("分配 AI 员工")).toBeInTheDocument();
    expect(screen.getByText("飞书消息")).toBeInTheDocument();
    expect(screen.getByText("调用本地/云端运行时")).toBeInTheDocument();
    expect(screen.getAllByText("需要审批").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("调用本地/云端运行时"));
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("shows a no-match state for search filters", async () => {
    renderPage();

    await screen.findByText("分配 AI 员工");

    fireEvent.change(screen.getByPlaceholderText("搜索工具、权限或调用方..."), {
      target: { value: "not-a-tool" },
    });

    expect(screen.getByText("没有匹配的工具")).toBeInTheDocument();
  });

  it("renders an error state when workspace resources fail to load", async () => {
    mockApi.listAgents.mockRejectedValue(new Error("network down"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("工具与权限加载失败")).toBeInTheDocument();
    });
    expect(screen.getByText("network down")).toBeInTheDocument();
  });
});
