import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Square, X } from "lucide-react";
import { Button } from "../../vendor/zcode/packages/ui/src/components/ui/button.tsx";
import { Input } from "../../vendor/zcode/packages/ui/src/components/ui/input.tsx";
import { useTabStore, useTabStoreApi } from "../../vendor/zcode/packages/ui/src/store/TabStoreProvider.tsx";
import { useZCodeSessionStore } from "../../vendor/zcode/packages/ui/src/store/zcodeSessionStore.ts";
import { useWorkbenchGroupStore } from "../../vendor/zcode/packages/ui/src/v4/workbenchGroupStore.ts";
import { usePaneLayoutStore } from "../../vendor/zcode/packages/ui/src/v4/paneLayoutStore.ts";
import { createBrowserController, desktopBrowserAvailable, EMPTY_BROWSER_STATE, isActiveRun, selectBrowserSession } from "./browser-session.js";
import { useBrowserViewport } from "./useBrowserViewport.js";
import { BrowserActionSummary } from "./BrowserActionSummary.jsx";
import { setPendingSettingsSection } from "../../vendor/zcode/packages/ui/src/lib/settingsNavigation.ts";

const statusLabels = { running: "运行中", awaiting_approval: "等待确认", stopped: "已停止",
  failed: "运行失败", needs_verification: "需要验证", blocked: "已阻塞" };
const describe = (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
const reportCleanupError = (error) => {
  console.error("浏览器清理失败", error);
  window.dispatchEvent(new CustomEvent("ai-me-browser-error", { detail: "浏览器运行未能确认停止，请重新打开面板检查并停止。" }));
};

/** 复用 Root 的 store；分屏聚焦、草稿、设置页都参与会话选择。 */
export function DesktopBrowserPanel({ visible, initialUrl, navigationRequest, onNavigationHandled, onClose }) {
  const tabs = useTabStore((state) => state);
  const groups = useWorkbenchGroupStore((state) => state);
  const layout = usePaneLayoutStore((state) => state);
  const sessionId = useZCodeSessionStore((state) => selectBrowserSession(tabs, state, groups, layout));
  const browser = desktopBrowserAvailable(window.aiMeDesktop) ? window.aiMeDesktop.browser : null;
  const activeId = visible && browser ? sessionId : null;
  const controller = useMemo(() => activeId ? createBrowserController(browser, activeId) : null, [browser, activeId]);
  const lastController = useRef(null);
  const consumedInitialUrl = useRef(null);
  const initialNavigation = useCallback(() => {
    if (navigationRequest) {
      if (consumedInitialUrl.current === navigationRequest.id) return undefined;
      consumedInitialUrl.current = navigationRequest.id;
      onNavigationHandled?.(navigationRequest.id);
      return navigationRequest.url;
    }
    if (consumedInitialUrl.current === initialUrl) return undefined;
    // 请求消费后不能再次用 initialUrl 导航，避免回到最初地址。
    if (consumedInitialUrl.current !== null) return undefined;
    consumedInitialUrl.current = initialUrl;
    return initialUrl;
  }, [initialUrl, navigationRequest, onNavigationHandled]);
  useLayoutEffect(() => {
    if (!controller) return;
    lastController.current = controller;
    return () => { void controller.dispose().catch(reportCleanupError); };
  }, [controller]);
  useLayoutEffect(() => () => {
    // 标签页真正关闭才销毁页面；折叠/设置覆盖只隐藏并停止运行。
    void lastController.current?.close().catch(reportCleanupError);
  }, []);
  if (!browser || !visible) return null;
  if (!activeId) return <div className="p-4 text-sm text-muted-foreground" role="status">请先创建或选择一个可操作的会话，再使用内置浏览器。</div>;
  return <BrowserSessionPanel key={activeId} browser={browser} sessionId={activeId}
    controller={controller} initialNavigation={initialNavigation} onClose={onClose} />;
}

/** 清理错误保留在宿主层，不能随隐藏的面板一起消失。 */
export function BrowserLifecycleNotice() {
  const [error, setError] = useState("");
  useEffect(() => {
    const receive = (event) => setError(event.detail);
    window.addEventListener("ai-me-browser-error", receive);
    return () => window.removeEventListener("ai-me-browser-error", receive);
  }, []);
  return error ? <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-background p-3 text-sm shadow-md">
    {error}<Button variant="ghost" onClick={() => setError("")}>知道了</Button>
  </div> : null;
}

export function BrowserSessionPanel({ browser, sessionId, controller, initialNavigation, onClose }) {
  const tabStore = useTabStoreApi();
  const [page, setPage] = useState(EMPTY_BROWSER_STATE);
  const [address, setAddress] = useState("");
  const [goal, setGoal] = useState("");
  const [confirmEachAction, setConfirmEachAction] = useState(true);
  const [config, setConfig] = useState(null);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const editingAddress = useRef(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const surface = useRef(null);
  const reportError = useCallback((cause) => {
    if (mounted.current) setError(cause?.message ?? String(cause));
  }, []);
  useBrowserViewport(browser, sessionId, surface, reportError);

  useEffect(() => {
    mounted.current = true;
    let timer;
    let stateVersion = 0;
    const updatePage = (state) => {
      if (!mounted.current || !state) return;
      setPage(state);
      if (!editingAddress.current) setAddress(state.url ?? "");
    };
    const unsubscribe = browser.onState((event) => {
      if (event.sessionId === sessionId) { stateVersion++; updatePage(event.state); }
    });
    const version = stateVersion;
    controller.command("state").then((state) => {
      // 初始化读取迟于导航事件返回时，不能覆盖较新的地址。
      if (stateVersion === version) updatePage(state);
    }).catch(reportError);
    const poll = async () => {
      try {
        const value = await controller.run("current");
        if (mounted.current) setRun(value);
      } catch (cause) { reportError(cause); }
      // 单次完成后再安排下一次，慢后端不会累积请求。
      if (mounted.current) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { mounted.current = false; clearTimeout(timer); unsubscribe?.(); };
  }, [browser, sessionId, controller, reportError]);
  useEffect(() => {
    const url = initialNavigation?.();
    if (url) controller.command("navigate", { url }).catch(reportError);
  }, [controller, initialNavigation, reportError]);
  useEffect(() => {
    let active = true;
    let timer;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      clearTimeout(timer);
      fetching = true;
      try {
        const value = await browser.run("", "config", {});
        if (active) setConfig(value);
      } catch (cause) { if (active) { setConfig(null); reportError(cause); } }
      finally {
        fetching = false;
        if (active) timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [browser, reportError]);

  async function perform(action) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try { await action(); } catch (cause) { reportError(cause); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const command = (operation, args) => perform(async () => {
    const state = await controller.command(operation, args);
    if (mounted.current && state) { setPage(state); if (!editingAddress.current) setAddress(state.url ?? ""); }
  });
  const runAction = (operation, args) => perform(async () => {
    if (operation === "start") setStarting(true);
    try {
      const value = await controller.run(operation, args);
      if (mounted.current) setRun(value);
    } finally { if (mounted.current) setStarting(false); }
  });
  async function stopRun() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try { const value = await controller.stop(); if (mounted.current) setRun(value); }
    catch (cause) { reportError(cause); }
    finally { stoppingRef.current = false; if (mounted.current) setStopping(false); }
  }
  const configured = config?.configured && config?.bridgeConnected !== false && config?.textConfigured;
  return <section data-testid="desktop-browser-panel" aria-label="内置浏览器" className="flex h-full min-h-0 flex-col bg-background text-foreground" data-session-id={sessionId}>
    <form className="flex shrink-0 items-center gap-1 border-b border-border p-2" onSubmit={(event) => {
      event.preventDefault();
      const value = address.trim();
      editingAddress.current = false;
      if (value) void command("navigate", { url: /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}` });
    }}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="后退" disabled={busy || !page.canGoBack} onClick={() => command("back")}><ArrowLeft /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="前进" disabled={busy || !page.canGoForward} onClick={() => command("forward")}><ArrowRight /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={page.loading ? "停止加载" : "刷新"} disabled={busy || !page.hasPage} onClick={() => command(page.loading ? "stop" : "reload")}>{page.loading ? <Square /> : <RefreshCw />}</Button>
      <Input data-testid="browser-address" aria-label="网页地址" value={address} onFocus={() => { editingAddress.current = true; }} onBlur={() => { editingAddress.current = false; }} onChange={(event) => setAddress(event.target.value)} placeholder="输入网址" spellCheck={false} />
      <Button type="submit" variant="ghost" disabled={busy || !address.trim()}>前往</Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭浏览器" disabled={busy} onClick={() => perform(async () => { await controller.close(); onClose(); })}><X /></Button>
    </form>
    <div className="shrink-0 truncate px-3 py-1 text-xs text-muted-foreground" title={page.title}>{page.loading ? "正在加载…" : page.title || "内置浏览器"}</div>
    <div ref={surface} data-testid="native-browser-viewport" className="relative min-h-24 flex-1 bg-muted/20">
      {!page.hasPage && <p className="p-4 text-sm text-muted-foreground">请先输入网址打开页面，再填写目标启动 Jev。</p>}
    </div>
    <div data-testid="browser-run-footer" className="h-[280px] max-h-[55%] shrink-0 space-y-3 overflow-y-auto border-t border-border p-3 text-sm">
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (configured && page.hasPage && !page.loading && !stopping && goal.trim() && !isActiveRun(run)) void runAction("start", { goal: goal.trim(), maxSteps: 20, confirmEachAction }); }}>
        <label className="flex flex-col gap-2"><span className="font-medium">Jev 浏览器目标</span><Input data-testid="jev-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="希望在当前网页完成什么？" disabled={busy || stopping || isActiveRun(run)} /></label>
        <label className="flex items-center gap-2"><input data-testid="jev-confirm-each-action" type="checkbox" checked={confirmEachAction} disabled={busy || stopping || isActiveRun(run)} onChange={(event) => setConfirmEachAction(event.target.checked)} />逐步确认</label>
        <p className="text-xs text-muted-foreground">关闭后自动执行本次任务的网页操作</p>
        {config === null ? <p className="text-muted-foreground">正在读取 Jev 配置…</p> : !configured ? <div className="text-muted-foreground">
          <p>{!config.configured ? "Jev 尚未配置，请前往设置 → 模型配置。" : config.bridgeConnected === false ? "浏览器桥接未连接，请检查桌面服务。" : "尚未配置文字模型，请前往设置 → 模型配置。"}</p>
          <Button data-testid="jev-open-settings" type="button" variant="link" onClick={() => { setPendingSettingsSection("modelProvider"); tabStore.getState().openSettingsTab(); }}>前往设置</Button>
        </div> : <p className="text-xs text-muted-foreground">{config.model} · 最多 20 步</p>}
        <div className="flex items-center gap-2">
          <Button data-testid="jev-start" type="submit" disabled={busy || stopping || !page.hasPage || page.loading || !configured || !goal.trim() || isActiveRun(run)}>启动 Jev</Button>
          <Button data-testid="jev-stop" type="button" variant="outline" disabled={stopping || (!starting && !isActiveRun(run))} onClick={stopRun}>{stopping ? "正在停止…" : "停止运行"}</Button>
          <span data-testid="jev-run-status" role="status">{starting ? "正在启动…" : statusLabels[run?.status] ?? "未启动"}</span>
        </div>
      </form>
      {error && <p role="alert" className="break-words text-destructive">{error}</p>}
      {run?.error && <p role="alert" className="break-words text-destructive">{describe(run.error)}</p>}
      {run?.status === "awaiting_approval" && run.pendingAction && <div data-testid="jev-pending-action" data-approval-id={run.pendingAction.approvalId} className="space-y-2 rounded-lg border border-border p-3">
        <p className="font-medium">待确认操作</p><BrowserActionSummary action={run.pendingAction} />
        <div className="flex gap-2"><Button data-testid="jev-approve" disabled={busy || stopping || !run.pendingAction.approvalId} onClick={() => runAction("approve", { runId: run.id, approve: true, approvalId: run.pendingAction.approvalId })}>允许</Button><Button data-testid="jev-reject" variant="outline" disabled={busy || stopping || !run.pendingAction.approvalId} onClick={() => runAction("approve", { runId: run.id, approve: false, approvalId: run.pendingAction.approvalId })}>拒绝</Button></div>
      </div>}
      <details open={Boolean(run?.steps?.length)}><summary className="cursor-pointer text-muted-foreground">步骤记录（{run?.steps?.length ?? 0}）</summary>
        <ol data-testid="jev-steps" className="mt-2 list-inside list-decimal space-y-2">{(run?.steps ?? []).map((step, index) => <li key={index}><BrowserActionSummary action={step} /></li>)}</ol>
      </details>
    </div>
  </section>;
}
