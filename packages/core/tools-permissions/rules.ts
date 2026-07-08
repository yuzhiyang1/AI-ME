import type { ToolPermissionRow, BuildToolPermissionRowsInput } from "./types";

function latestRuntimeSeenAt(runtimes: BuildToolPermissionRowsInput["runtimes"]) {
  return runtimes.reduce<string | null>((latest, runtime) => {
    if (!runtime.last_seen_at) return latest;
    if (!latest) return runtime.last_seen_at;
    return new Date(runtime.last_seen_at).getTime() > new Date(latest).getTime()
      ? runtime.last_seen_at
      : latest;
  }, null);
}

export function buildToolPermissionRows({
  agents,
  runtimes,
  skills,
  approvalStats,
  feishuStatus,
}: BuildToolPermissionRowsInput): ToolPermissionRow[] {
  const activeAgents = agents.filter((agent) => !agent.archived_at);
  const onlineRuntimes = runtimes.filter((runtime) => runtime.status === "online");
  const runtimeProviders = new Set(runtimes.map((runtime) => runtime.provider).filter(Boolean));
  const pendingApprovals = approvalStats?.pending ?? 0;
  const failedApprovals = approvalStats?.failed ?? 0;
  const feishuConfigured =
    feishuStatus?.incoming_configured === true &&
    feishuStatus?.outgoing_configured === true;
  const feishuPartiallyConfigured =
    feishuStatus?.incoming_configured === true ||
    feishuStatus?.outgoing_configured === true ||
    feishuStatus?.webhook_configured === true ||
    feishuStatus?.websocket_configured === true;

  return [
    {
      id: "workspace-read",
      category: "system",
      name: "Read work items and context",
      description: "AI-Me and workers can read issues, comments, activity, and required workspace context.",
      availability: "enabled",
      approvalBehavior: "auto",
      scope: "Current workspace",
      callers: "AI-Me, Codex, Claude Code",
      source: "Issue / Comment / Activity",
      auditHint: "Read actions are traceable through activity, approval evidence, and worker run logs.",
      primaryCount: activeAgents.length,
      secondaryCount: 0,
      lastUsedAt: null,
    },
    {
      id: "assign-worker",
      category: "development",
      name: "Assign AI workers",
      description: "Hand an issue to Codex, Claude Code, or another worker and enqueue an agent task.",
      availability: activeAgents.length > 0 ? "enabled" : "not_configured",
      approvalBehavior: "requires_approval",
      scope: "Assignable workspace workers",
      callers: "AI-Me",
      source: `${activeAgents.length} workers`,
      auditHint: pendingApprovals > 0 ? `${pendingApprovals} approvals pending` : "Execution results are recorded after approval.",
      primaryCount: activeAgents.length,
      secondaryCount: pendingApprovals,
      lastUsedAt: null,
    },
    {
      id: "runtime-execution",
      category: "development",
      name: "Call local/cloud runtimes",
      description: "Workers use registered runtimes for code reading, edits, tests, and task reports.",
      availability: runtimes.length > 0 ? "enabled" : "not_configured",
      approvalBehavior: "auto",
      scope: "Runtime owner and workspace access",
      callers: runtimeProviders.size > 0 ? Array.from(runtimeProviders).join(" / ") : "Codex / Claude Code",
      source: `${onlineRuntimes.length}/${runtimes.length} online`,
      auditHint: failedApprovals > 0 ? `${failedApprovals} approval executions need review` : "Runtime activity is captured in execution logs and worker activity.",
      primaryCount: runtimes.length,
      secondaryCount: onlineRuntimes.length,
      lastUsedAt: latestRuntimeSeenAt(runtimes),
    },
    {
      id: "post-internal-comment",
      category: "system",
      name: "Post internal comments",
      description: "Write AI-Me drafted internal notes to issue comments as team-visible records.",
      availability: "enabled",
      approvalBehavior: "requires_approval",
      scope: "Linked issue",
      callers: "AI-Me",
      source: "Comment",
      auditHint: "The approval center keeps the original payload, final payload, and comment ID.",
      primaryCount: approvalStats?.succeeded ?? 0,
      secondaryCount: failedApprovals,
      lastUsedAt: null,
    },
    {
      id: "feishu-messages",
      category: "communication",
      name: "Feishu messages",
      description: "Receive Feishu messages into AI-Me and send approved replies back as the bot.",
      availability: feishuConfigured
        ? "enabled"
        : feishuPartiallyConfigured
          ? "available"
          : "not_configured",
      approvalBehavior: "always_requires_approval",
      scope: feishuStatus?.allowed_chat_configured
        ? "Allowed Feishu chat"
        : `Workspace ${feishuStatus?.event_mode ?? "webhook"} intake`,
      callers: "AI-Me",
      source: feishuStatus?.incoming_configured
        ? `${feishuStatus.event_mode} intake`
        : "Not connected",
      auditHint:
        feishuStatus && feishuStatus.warnings.length > 0
          ? feishuStatus.warnings.join(", ")
          : "Inbound messages enter the exception inbox; outbound replies always require approval.",
      primaryCount: feishuConfigured ? 1 : 0,
      secondaryCount: feishuStatus?.warnings.length ?? 0,
      lastUsedAt: null,
    },
    {
      id: "external-message",
      category: "communication",
      name: "Send external messages",
      description: "External communication, commitments, and replies must go through approval first.",
      availability: "available",
      approvalBehavior: "always_requires_approval",
      scope: "External contacts and integrations",
      callers: "AI-Me",
      source: "Approval Center",
      auditHint: "External sends record channel, message ID, and execution failure details.",
      primaryCount: pendingApprovals,
      secondaryCount: failedApprovals,
      lastUsedAt: null,
    },
    {
      id: "skills-context",
      category: "data",
      name: "Use skill context",
      description: "Workers use bound skills for SOPs and operating instructions; skill management remains permission-controlled.",
      availability: skills.length > 0 ? "enabled" : "not_configured",
      approvalBehavior: "auto",
      scope: "Workers with bound skills",
      callers: "AI workers",
      source: `${skills.length} skills`,
      auditHint: "Skill changes are tracked by the skills page and worker configuration.",
      primaryCount: skills.length,
      secondaryCount: activeAgents.filter((agent) => (agent.skills ?? []).length > 0).length,
      lastUsedAt: null,
    },
    {
      id: "memory-external-use",
      category: "data",
      name: "Use memory externally",
      description: "with_approval memories may support internal drafts, but final external use requires approval.",
      availability: "available",
      approvalBehavior: "requires_approval",
      scope: "Memories allowed for external use",
      callers: "AI-Me",
      source: "Memory policy",
      auditHint: "Approval evidence should reference every memory ID used.",
      primaryCount: 0,
      secondaryCount: pendingApprovals,
      lastUsedAt: null,
    },
    {
      id: "merge-pull-request",
      category: "publishing",
      name: "Merge pull requests",
      description: "v0.1 keeps this as a policy placeholder and does not execute GitHub merges directly.",
      availability: "disabled",
      approvalBehavior: "blocked",
      scope: "GitHub / GitLab",
      callers: "AI-Me",
      source: "Not connected",
      auditHint: "Define permission policy and audit records before enabling this integration.",
      primaryCount: 0,
      secondaryCount: 0,
      lastUsedAt: null,
    },
    {
      id: "production-deploy",
      category: "publishing",
      name: "Production deploy",
      description: "Production deployment is irreversible and high risk; v0.1 does not allow automatic execution.",
      availability: "disabled",
      approvalBehavior: "blocked",
      scope: "Production environment",
      callers: "AI-Me",
      source: "Not connected",
      auditHint: "Even after future integration, this action must always require approval.",
      primaryCount: 0,
      secondaryCount: 0,
      lastUsedAt: null,
    },
  ];
}
