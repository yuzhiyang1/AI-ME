import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type { Agent, MemberWithUser, Workspace } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const currentUserRef = vi.hoisted(() => ({
  current: { id: "user-owner" } as { id: string } | null,
}));

vi.mock("@multica/core/api", () => ({
  api: {
    listWorkspaces: vi.fn(),
    listMembers: vi.fn(),
    listAgents: vi.fn(),
    updateWorkspace: mockUpdateWorkspace,
  },
}));

vi.mock("@multica/core/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@multica/core/auth")>(
      "@multica/core/auth",
    );
  const useAuthStore = Object.assign(
    (selector?: (state: { user: typeof currentUserRef.current }) => unknown) =>
      selector
        ? selector({ user: currentUserRef.current })
        : { user: currentUserRef.current },
    { getState: () => ({ user: currentUserRef.current }) },
  );
  return { ...actual, useAuthStore };
});

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

import { AIMeSettingsTab } from "./aime-settings-tab";

const TEST_RESOURCES = {
  en: { common: enCommon, settings: enSettings },
};

const workspace: Workspace = {
  id: "ws-1",
  name: "AI-Me Workspace",
  slug: "ai-me",
  description: null,
  context: null,
  settings: {
    co_authored_by_enabled: false,
    ai_me: {
      enabled: true,
      autonomy_level: "balanced",
      approval_mode: "risky",
      digest_cadence: "realtime",
      timezone: "Asia/Shanghai",
      working_hours: { start: "09:00", end: "18:00" },
      model_provider: "deepseek",
      model_name: "deepseek-chat",
      memory_retention_days: 180,
      data_retention_days: 365,
      updated_at: null,
    },
  },
  repos: [],
  issue_prefix: "MUL",
  created_at: "2026-07-08T00:00:00.000Z",
  updated_at: "2026-07-08T00:00:00.000Z",
};

function makeMember(role: MemberWithUser["role"]): MemberWithUser {
  return {
    id: `member-${role}`,
    workspace_id: workspace.id,
    user_id: "user-owner",
    role,
    created_at: "2026-07-08T00:00:00.000Z",
    name: "Owner",
    email: "owner@example.com",
    avatar_url: null,
  };
}

function makeAgent(patch: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    workspace_id: workspace.id,
    runtime_id: "runtime-1",
    name: "Codex Worker",
    description: "",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_env: {},
    custom_args: [],
    custom_env_redacted: false,
    visibility: "workspace",
    status: "working",
    max_concurrent_tasks: 1,
    model: "deepseek-chat",
    owner_id: null,
    skills: [],
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    archived_at: null,
    archived_by: null,
    ...patch,
  };
}

function TestWrapper({
  children,
  role = "owner",
}: {
  children: ReactNode;
  role?: MemberWithUser["role"];
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(workspaceKeys.list(), [workspace]);
  queryClient.setQueryData(workspaceKeys.members(workspace.id), [makeMember(role)]);
  queryClient.setQueryData(workspaceKeys.agents(workspace.id), [
    makeAgent({ id: "agent-online", status: "working" }),
    makeAgent({ id: "agent-offline", status: "offline", model: "gpt-4.1" }),
  ]);

  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <WorkspaceSlugProvider slug={workspace.slug}>
          {children}
        </WorkspaceSlugProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

describe("AIMeSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserRef.current = { id: "user-owner" };
    mockUpdateWorkspace.mockImplementation(
      async (_id: string, data: Partial<Workspace>) => ({
        ...workspace,
        ...data,
      }),
    );
  });

  it("renders real workspace settings and agent-derived status", () => {
    render(<AIMeSettingsTab />, {
      wrapper: ({ children }) => <TestWrapper>{children}</TestWrapper>,
    });

    expect(screen.getByText("AI-Me Settings")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Asia/Shanghai")).toBeInTheDocument();
  });

  it("saves merged workspace settings for owners", async () => {
    const user = userEvent.setup();
    render(<AIMeSettingsTab />, {
      wrapper: ({ children }) => <TestWrapper>{children}</TestWrapper>,
    });

    await user.click(screen.getByRole("switch", { name: "Enable AI-Me" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mockUpdateWorkspace).toHaveBeenCalledTimes(1));
    expect(mockUpdateWorkspace).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        settings: expect.objectContaining({
          co_authored_by_enabled: false,
          ai_me: expect.objectContaining({
            enabled: false,
            model_provider: "deepseek",
            model_name: "deepseek-chat",
          }),
        }),
      }),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("AI-Me settings saved");
  });

  it("keeps member users read-only", async () => {
    const user = userEvent.setup();
    render(<AIMeSettingsTab />, {
      wrapper: ({ children }) => (
        <TestWrapper role="member">{children}</TestWrapper>
      ),
    });

    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
    expect(
      screen.getByText("Only admins and owners can update AI-Me settings."),
    ).toBeInTheDocument();
  });
});
