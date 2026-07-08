import { describe, expect, it } from "vitest";
import type { AIApprovalStats, Agent, AgentRuntime, SkillSummary } from "../types";
import { buildToolPermissionRows } from "./rules";

function agent(patch: Partial<Agent> = {}): Agent {
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
    owner_id: null,
    skills: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...patch,
  };
}

function runtime(patch: Partial<AgentRuntime> = {}): AgentRuntime {
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
    ...patch,
  };
}

function skill(patch: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "skill-1",
    workspace_id: "ws-1",
    name: "AI-Me UI",
    description: "",
    config: {},
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

const stats: AIApprovalStats = {
  total: 4,
  pending: 2,
  high_risk_pending: 1,
  observing: 0,
  approved: 1,
  rejected: 0,
  taken_over: 0,
  expired: 0,
  succeeded: 1,
  failed: 1,
};

describe("buildToolPermissionRows", () => {
  it("derives enabled worker dispatch and runtime rows from real workspace data", () => {
    const rows = buildToolPermissionRows({
      agents: [agent()],
      runtimes: [runtime()],
      skills: [skill()],
      approvalStats: stats,
    });

    expect(rows.find((row) => row.id === "assign-worker")).toMatchObject({
      availability: "enabled",
      approvalBehavior: "requires_approval",
      primaryCount: 1,
      secondaryCount: 2,
    });
    expect(rows.find((row) => row.id === "runtime-execution")).toMatchObject({
      availability: "enabled",
      callers: "codex",
      primaryCount: 1,
      secondaryCount: 1,
      lastUsedAt: "2026-01-02T00:00:00Z",
    });
    expect(rows.find((row) => row.id === "feishu-messages")).toMatchObject({
      availability: "not_configured",
      approvalBehavior: "always_requires_approval",
    });
  });

  it("marks optional resources as not configured when the workspace has none", () => {
    const rows = buildToolPermissionRows({
      agents: [],
      runtimes: [],
      skills: [],
      approvalStats: null,
    });

    expect(rows.find((row) => row.id === "assign-worker")?.availability).toBe("not_configured");
    expect(rows.find((row) => row.id === "runtime-execution")?.availability).toBe("not_configured");
    expect(rows.find((row) => row.id === "skills-context")?.availability).toBe("not_configured");
  });

  it("keeps irreversible publishing actions blocked in v0.1", () => {
    const rows = buildToolPermissionRows({
      agents: [agent()],
      runtimes: [runtime()],
      skills: [],
    });

    expect(rows.find((row) => row.id === "merge-pull-request")).toMatchObject({
      availability: "disabled",
      approvalBehavior: "blocked",
    });
    expect(rows.find((row) => row.id === "production-deploy")).toMatchObject({
      availability: "disabled",
      approvalBehavior: "blocked",
    });
  });

  it("derives Feishu availability from integration status", () => {
    const rows = buildToolPermissionRows({
      agents: [agent()],
      runtimes: [runtime()],
      skills: [],
      approvalStats: stats,
      feishuStatus: {
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
      },
    });

    expect(rows.find((row) => row.id === "feishu-messages")).toMatchObject({
      availability: "enabled",
      approvalBehavior: "always_requires_approval",
      primaryCount: 1,
      secondaryCount: 0,
    });
  });
});
