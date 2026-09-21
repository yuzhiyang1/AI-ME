/** ZCode 用 workspacePath 作 UI 主键；项目使用逻辑地址，绝不把该地址发给文件系统。 */
const PROJECT_PREFIX = "ai-me-project://";
export const projectKey = (id) => `${PROJECT_PREFIX}${id}`;
export const projectIdFromKey = (key) =>
  key?.startsWith(PROJECT_PREFIX) ? key.slice(PROJECT_PREFIX.length) : null;
/** Windows 目录身份忽略斜杠和大小写，Linux 路径保持大小写敏感。 */
export function normalizeWorkspaceKey(path) {
  if (!path || path.startsWith(PROJECT_PREFIX)) return path;
  if (/^[a-z]:[\\/]/i.test(path)) {
    const normalized =
      path[0].toUpperCase() +
      path.slice(1).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    return normalized.endsWith(":") ? `${normalized}/` : normalized;
  }
  if (path.startsWith("\\\\"))
    return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return path;
}
export const sessionWorkspaceKey = (session) =>
  session.projectId
    ? projectKey(session.projectId)
    : normalizeWorkspaceKey(session.workspacePath);

/** 目录可以被多个项目共用，不能由路径反推归属。归属只信任后端 projectId。 */
export function createProjectDirectory(initialProjects, initialSessions) {
  let projects = initialProjects;
  let sessions = initialSessions;
  const draftPaths = new Set();
  return {
    replace(nextProjects, nextSessions = sessions) {
      projects = nextProjects;
      sessions = nextSessions;
    },
    list: () => projects,
    rememberStandalone(path) {
      draftPaths.add(path);
    },
    paths: () => [
      ...new Set([
        ...projects.map((p) => projectKey(p.id)),
        ...draftPaths,
        ...sessions.filter((s) => !s.projectId).map(sessionWorkspaceKey),
      ]),
    ],
    label(key) {
      const id = projectIdFromKey(key);
      return id
        ? (projects.find((p) => p.id === id)?.name ?? "已删除项目")
        : undefined;
    },
    sessionInput(key) {
      const projectId = projectIdFromKey(key);
      if (!projectId) return { workspacePath: key };
      if (!projects.some((p) => p.id === projectId))
        throw new Error("项目已删除，请重新选择项目");
      return { projectId };
    },
    physicalPath(key) {
      const id = projectIdFromKey(key);
      if (!id) return key;
      const project = projects.find((p) => p.id === id);
      if (!project) throw new Error("项目已删除，请重新选择项目");
      return (
        project.roots.find((r) => r.primary)?.path ?? project.roots[0]?.path
      );
    },
  };
}

/** 对话框只负责用户选择；取消、卸载都会结清等待中的调用。 */
export function createProjectDialogBridge() {
  let listener;
  let selectedListener;
  let pending;
  const close = (value = null) => {
    pending?.(value);
    pending = undefined;
    listener?.(false);
    if (value) selectedListener?.(value);
  };
  return {
    open: () => {
      if (!listener) return Promise.reject(new Error("项目管理界面尚未就绪"));
      close();
      return new Promise((resolve) => {
        pending = resolve;
        listener(true);
      });
    },
    close,
    onSelect(callback) {
      selectedListener = callback;
      return () => {
        selectedListener = undefined;
      };
    },
    subscribe(callback) {
      listener = callback;
      return () => {
        close();
        listener = undefined;
      };
    },
  };
}
