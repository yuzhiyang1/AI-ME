import type {
  AIApprovalStats,
  Agent,
  AgentRuntime,
  FeishuIntegrationStatus,
  SkillSummary,
} from "../types";

export type ToolPermissionCategory =
  | "communication"
  | "development"
  | "data"
  | "publishing"
  | "system";

export type ToolPermissionApprovalBehavior =
  | "auto"
  | "requires_approval"
  | "always_requires_approval"
  | "blocked";

export type ToolPermissionAvailability =
  | "enabled"
  | "available"
  | "not_configured"
  | "disabled";

export interface BuildToolPermissionRowsInput {
  agents: Agent[];
  runtimes: AgentRuntime[];
  skills: SkillSummary[];
  approvalStats?: AIApprovalStats | null;
  feishuStatus?: FeishuIntegrationStatus | null;
}

export interface ToolPermissionRow {
  id: string;
  category: ToolPermissionCategory;
  name: string;
  description: string;
  availability: ToolPermissionAvailability;
  approvalBehavior: ToolPermissionApprovalBehavior;
  scope: string;
  callers: string;
  source: string;
  auditHint: string;
  primaryCount: number;
  secondaryCount: number;
  lastUsedAt: string | null;
}
