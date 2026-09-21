import { useEffect, useState } from "react";
import { useTabStoreApi } from "../../vendor/zcode/packages/ui/src/store/TabStoreProvider.tsx";
import { ProjectManager } from "./ProjectManager.jsx";
import { projectIdFromKey } from "./projects.js";
import { useWorkbenchGroupStore } from "../../vendor/zcode/packages/ui/src/v4/workbenchGroupStore.ts";
import { usePaneLayoutStore } from "../../vendor/zcode/packages/ui/src/v4/paneLayoutStore.ts";
import { useZCodeSessionStore } from "../../vendor/zcode/packages/ui/src/store/zcodeSessionStore.ts";

/** 同步项目元数据，不重新挂载 Root，以免中断正在查看的会话和输入草稿。 */
export function ProjectWorkspaceBridge({ host }) {
  const store = useTabStoreApi();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const paths = host.directory.paths();
    for (const path of paths)
      store
        .getState()
        .ensureWorkspaceTab(path, {
          workspacePurpose: projectIdFromKey(path) ? "project" : "conversation",
        });
    const state = store.getState();
    for (const tab of state.tabs) {
      if (tab.kind === "workspace" && !paths.includes(tab.workspacePath))
        state.closeTab(tab.id);
    }
    store.setState((current) => ({
      tabs: current.tabs.map((tab) =>
        tab.kind === "workspace"
          ? {
              ...tab,
              label: host.directory.label(tab.workspacePath) ?? tab.label,
            }
          : tab,
      ),
    }));
  }, [host, store, revision]);
  useEffect(
    () => host.projectDialog.onSelect((path) => {
      // 从偏好菜单打开项目同样是新草稿意图，不可残留另一项目的活动会话绑定。
      store.getState().addTab(path);
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore.getState().startDraft(path);
    }),
    [host, store],
  );
  return (
    <ProjectManager
      host={host}
      onChanged={() => setRevision((value) => value + 1)}
    />
  );
}
