import { openBrowserSidePane, sidePaneOwnerKey, type WorkspaceSidePaneState } from "./workspaceSidePane.js";

/** 宿主每会话只有一个页面；新入口与消息链接必须认领同一个标签。 */
export function openHostBrowserSidePane(current: WorkspaceSidePaneState | null, ownerTaskId: string | null, workspaceKey: string, url?: string) {
  const existing = current?.tabs.find((tab) => tab.type === "browser" &&
    sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(ownerTaskId) &&
    (!tab.workspaceKey || tab.workspaceKey === workspaceKey));
  if (current && existing) return { ...current, activeTabId: existing.id };
  return openBrowserSidePane(current, { ownerTaskId, workspaceKey, initialUrl: url });
}
