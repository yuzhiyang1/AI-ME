/** 只开放完整的桌面 bridge；普通 Web 或旧 preload 不展示浏览器入口。 */
export function desktopBrowserAvailable(desktop) {
  return desktop?.mode === "desktop" &&
    ["command", "setViewport", "onState", "run"].every(
      (method) => typeof desktop.browser?.[method] === "function",
    );
}

/** 与 V4WorkspaceChatArea 的焦点优先级一致，草稿绝不回退到上一个会话。 */
export function selectBrowserSession(tabs, sessions, groups, layout) {
  const tab = tabs.tabs.find((item) => item.id === tabs.activeTabId);
  if (tab?.kind !== "workspace") return null;
  const group = groups.groups[groups.activeGroupId];
  const focused = group?.focusedPaneId ?? layout.focusedPaneId;
  const binding = group
    ? (focused === "workspace-main" ? group.primaryBinding : group.panes[focused])
    : layout.panes[focused];
  if (group || focused !== "workspace-main") {
    if (!binding || binding.readOnly || binding.restoredUnvalidated || binding.workspaceScope.remoteSessionId)
      return null;
    return binding.sessionId || null;
  }
  if (tab.remoteSessionId || tab.workspaceIdentity) return null;
  // services.taskMeta 把后端 session.id 原样映射到 taskId，不需要等待列表缓存刷新。
  const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
  return sessions.workspaces[key]?.activeTaskId || null;
}

export const EMPTY_BROWSER_STATE = {
  url: "", title: "", canGoBack: false, canGoForward: false, loading: false, hasPage: false,
};
export const isActiveRun = (run) => ["running", "awaiting_approval"].includes(run?.status);

// 同一 bridge/session 的新旧面板共享队列：旧 start 返回后先 stop，再允许新面板 start。
const queues = new WeakMap();
function enqueue(browser, sessionId, operation) {
  let sessions = queues.get(browser);
  if (!sessions) queues.set(browser, sessions = new Map());
  const previous = sessions.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  sessions.set(sessionId, next);
  const release = () => { if (sessions.get(sessionId) === next) sessions.delete(sessionId); };
  void next.then(release, release);
  return next;
}

/** 生命周期持有会话 ID 快照，异步返回不能写入切换后的会话。 */
export function createBrowserController(browser, sessionId) {
  let disposed = false;
  let lastRun = null;
  let stopping = null;
  let closing = null;
  let cancellation = 0;
  const command = (operation, args = {}) => enqueue(browser, sessionId,
    () => browser.command(sessionId, operation, args));
  const run = (operation, args = {}) => {
    const generation = cancellation;
    return enqueue(browser, sessionId, async () => {
    // cleanup 已发生时，不执行仍在排队的启动或批准。
    if ((disposed || generation !== cancellation) && ["start", "approve"].includes(operation)) return null;
    const result = await browser.run(sessionId, operation, args);
    if (operation !== "config") lastRun = result;
    return result;
    });
  };
  const stop = () => {
    cancellation++;
    // 撤销执行授权必须立即发 IPC，不排在 start/approve/HTTP 请求后面。
    let revoke;
    try { revoke = Promise.resolve(browser.run(sessionId, "revoke", {})); }
    catch (error) { revoke = Promise.reject(error); }
    const stopped = enqueue(browser, sessionId, async () => {
    // 即使首次 current 尚未返回，也能找到后台运行；不能凭 UI 缓存认定已停止。
    let current;
    try { current = await browser.run(sessionId, "current", {}); }
    catch (error) { if (!isActiveRun(lastRun)) throw error; current = lastRun; }
    if (isActiveRun(current)) current = await browser.run(sessionId, "stop", { runId: current.id });
    lastRun = current;
    return current;
    });
    return Promise.allSettled([revoke, stopped]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      return results[1].value;
    });
  };
  return {
    command, run, stop,
    dispose() {
      if (stopping) return stopping;
      disposed = true;
      // 原生层先撤下，停止请求随后按队列执行，不让网络延迟遮住新会话或模态框。
      let hidden;
      try { hidden = Promise.resolve(browser.setViewport({ sessionId, rect: null })); }
      catch (error) { hidden = Promise.reject(error); }
      stopping = Promise.allSettled([stop(), hidden]).then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      });
      return stopping;
    },
    close() {
      if (closing) return closing;
      const stopped = this.dispose();
      // 立即排入队列，避免卸载后的 close 越过新面板的 state/start。
      closing = enqueue(browser, sessionId, async () => {
        await stopped;
        return browser.command(sessionId, "close", {});
      });
      return closing;
    },
  };
}
