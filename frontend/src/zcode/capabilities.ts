/**
 * ZCode 工作台能力目录。
 *
 * 能力是否在当前产品展示由这里控制；暂时不用的功能应该设置为 hidden，
 * 不应该从组件和适配层删除，避免 AI-ME 后续无法覆盖 ZCode 的完整能力面。
 */
export const zcodeCapabilityIds = [
  "workspace",
  "tasks",
  "chat",
  "tool_calls",
  "approvals",
  "model_settings",
  "context_usage",
  "terminal",
  "file_tree",
  "diff_preview",
  "git",
  "plans",
  "mcp",
  "browser",
  "document_preview",
  "image_preview",
  "remote_workspace",
  "conversation_share",
  "automations",
  "plugins",
  "i18n",
  "themes",
  "diagnostics",
] as const;

export type ZCodeCapabilityId = (typeof zcodeCapabilityIds)[number];

export type ZCodeCapabilityState = "enabled" | "hidden" | "unavailable";

export interface ZCodeCapability {
  /** 能力稳定标识，作为前端路由、权限和埋点的关联键。 */
  id: ZCodeCapabilityId;
  /** 展示名称。 */
  label: string;
  /** 当前状态：enabled 展示，hidden 暂不展示，unavailable 展示但不可用。 */
  state: ZCodeCapabilityState;
  /** 能力尚未接入时，说明缺少的 AI-ME 后端能力。 */
  missingBackendCapabilities?: readonly string[];
}

/**
 * AI-ME 当前工作台能力配置。
 * 后续产品裁剪只调整状态，不删除 ZCode 能力定义和对应组件入口。
 */
export const defaultZCodeCapabilities: readonly ZCodeCapability[] = [
  { id: "workspace", label: "工作区", state: "enabled" },
  { id: "tasks", label: "任务", state: "enabled" },
  { id: "chat", label: "对话", state: "enabled" },
  { id: "tool_calls", label: "工具调用", state: "enabled" },
  { id: "approvals", label: "执行审批", state: "enabled" },
  { id: "model_settings", label: "模型设置", state: "enabled" },
  { id: "context_usage", label: "上下文用量", state: "enabled" },
  { id: "terminal", label: "终端", state: "unavailable", missingBackendCapabilities: ["terminal_session"] },
  { id: "file_tree", label: "文件树", state: "unavailable", missingBackendCapabilities: ["workspace_files"] },
  { id: "diff_preview", label: "Diff 预览", state: "unavailable", missingBackendCapabilities: ["workspace_diff"] },
  { id: "git", label: "Git", state: "unavailable", missingBackendCapabilities: ["git_status", "git_operations"] },
  { id: "plans", label: "任务计划", state: "unavailable", missingBackendCapabilities: ["plan_items"] },
  { id: "mcp", label: "MCP", state: "unavailable", missingBackendCapabilities: ["mcp_servers"] },
  { id: "browser", label: "浏览器", state: "unavailable", missingBackendCapabilities: ["browser_session"] },
  { id: "document_preview", label: "文档预览", state: "unavailable" },
  { id: "image_preview", label: "图片预览", state: "unavailable" },
  { id: "remote_workspace", label: "远程工作区", state: "unavailable", missingBackendCapabilities: ["remote_workspace"] },
  { id: "conversation_share", label: "会话分享", state: "unavailable", missingBackendCapabilities: ["conversation_share"] },
  { id: "automations", label: "自动化", state: "unavailable", missingBackendCapabilities: ["automation_jobs"] },
  { id: "plugins", label: "插件", state: "unavailable", missingBackendCapabilities: ["plugin_registry"] },
  { id: "i18n", label: "多语言", state: "enabled" },
  { id: "themes", label: "主题", state: "enabled" },
  { id: "diagnostics", label: "诊断", state: "enabled" },
];

export function createCapabilityMap(
  capabilities: readonly ZCodeCapability[] = defaultZCodeCapabilities,
): ReadonlyMap<ZCodeCapabilityId, ZCodeCapability> {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}

export function isCapabilityEnabled(
  id: ZCodeCapabilityId,
  capabilities: readonly ZCodeCapability[] = defaultZCodeCapabilities,
): boolean {
  return capabilities.some((capability) => capability.id === id && capability.state === "enabled");
}
