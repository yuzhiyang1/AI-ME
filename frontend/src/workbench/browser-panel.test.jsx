// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopBrowserPanel } from "./DesktopBrowserPanel.jsx";
import { JevSettings } from "./JevSettings.jsx";
import { createBrowserController, desktopBrowserAvailable, EMPTY_BROWSER_STATE, selectBrowserSession } from "./browser-session.js";
import { TabStoreProvider, useTabStoreApi } from "../../vendor/zcode/packages/ui/src/store/TabStoreProvider.tsx";
import { useZCodeSessionStore } from "../../vendor/zcode/packages/ui/src/store/zcodeSessionStore.ts";
import { usePaneLayoutStore, INITIAL_PANE_LAYOUT } from "../../vendor/zcode/packages/ui/src/v4/paneLayoutStore.ts";
import { useWorkbenchGroupStore } from "../../vendor/zcode/packages/ui/src/v4/workbenchGroupStore.ts";
import { openHostBrowserSidePane } from "../../vendor/zcode/packages/ui/src/lib/hostBrowserSidePane.ts";

let browser, listener, tabStore, currentRun, config, page;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function Stores({ children }) {
  tabStore = useTabStoreApi();
  return children;
}
function mountPanel() {
  const view = render(<TabStoreProvider><Stores><DesktopBrowserPanel visible onClose={() => {}} /></Stores></TabStoreProvider>);
  act(() => {
    tabStore.getState().addTab("project:p1");
    useZCodeSessionStore.getState().setActiveTaskId("project:p1", "real-session-1");
  });
  return view;
}
beforeEach(() => {
  localStorage.clear();
  useZCodeSessionStore.setState({ workspaces: {} });
  usePaneLayoutStore.setState(INITIAL_PANE_LAYOUT);
  useWorkbenchGroupStore.setState({ groups: {}, activeGroupId: null, sessionIndex: {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 400, y: 80, left: 400, top: 80, right: 1000, bottom: 500, width: 600, height: 420 });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}]);
  page = { ...EMPTY_BROWSER_STATE, hasPage: true, url: "https://example.com", title: "示例网页", canGoBack: true, canGoForward: true };
  config = { configured: true, textConfigured: true, bridgeConnected: true, model: "jev-latest" };
  currentRun = null;
  browser = {
    setViewport: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn((receive) => { listener = receive; return vi.fn(); }),
    command: vi.fn(async (_session, operation, args) => {
      if (operation === "navigate") page = { ...page, url: args.url };
      return page;
    }),
    run: vi.fn(async (sessionId, operation, args) => {
      if (operation === "config" || operation === "configure") return config;
      if (operation === "start") currentRun = { id: "run-1", sessionId, status: "running", steps: [], goal: args.goal };
      if (operation === "stop") currentRun = { ...currentRun, status: "stopped" };
      if (operation === "approve") currentRun = { ...currentRun, status: args.approve ? "running" : "stopped", pendingAction: undefined };
      if (operation === "revoke") return null;
      return currentRun;
    }),
  };
  window.aiMeDesktop = { mode: "desktop", platform: "win32", browser };
});
afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.aiMeDesktop;
});

describe("桌面浏览器窄集成", () => {
  it("只有完整桌面能力才启用，草稿不使用临时 draftSessionId", () => {
    expect(desktopBrowserAvailable(window.aiMeDesktop)).toBe(true);
    expect(desktopBrowserAvailable({ browser })).toBe(false);
    expect(desktopBrowserAvailable({ mode: "desktop", browser: { ...browser, run: undefined } })).toBe(false);
    const tabs = { tabs: [{ id: "tab", kind: "workspace", workspacePath: "p" }], activeTabId: "tab" };
    const sessions = { workspaces: { p: { activeTaskId: null, draftSessionId: "draft-unsafe" } } };
    expect(selectBrowserSession(tabs, sessions, { groups: {} }, INITIAL_PANE_LAYOUT)).toBeNull();
    const groups = { activeGroupId: "g", groups: { g: { focusedPaneId: "secondary", panes: { secondary: { sessionId: "focused-real", workspaceScope: { workspacePath: "p2" } } } } } };
    expect(selectBrowserSession(tabs, sessions, groups, INITIAL_PANE_LAYOUT)).toBe("focused-real");
    groups.groups.g.panes.secondary.restoredUnvalidated = true;
    expect(selectBrowserSession(tabs, sessions, groups, INITIAL_PANE_LAYOUT)).toBeNull();
  });

  it("重复入口复用同会话页，跨会话保留独立页", () => {
    const first = openHostBrowserSidePane(null, "s1", "p");
    const twice = openHostBrowserSidePane(first, "s1", "p", "https://example.com");
    expect(twice.tabs).toHaveLength(1);
    expect(twice.activeTabId).toBe(first.activeTabId);
    const other = openHostBrowserSidePane(twice, "s2", "p");
    expect(other.tabs).toHaveLength(2);
    expect(openHostBrowserSidePane(other, "s1", "p").activeTabId).toBe(first.activeTabId);
  });

  it("真实 store 会话、地址控制、事件隔离和编辑保护", async () => {
    mountPanel();
    await screen.findByDisplayValue("https://example.com");
    expect(browser.command).toHaveBeenCalledWith("real-session-1", "state", {});
    const address = screen.getByLabelText("网页地址");
    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: "next.example.com" } });
    act(() => listener({ sessionId: "real-session-1", state: { ...page, loading: true } }));
    expect(address.value).toBe("next.example.com");
    act(() => listener({ sessionId: "other-session", state: { ...page, url: "https://wrong.test" } }));
    expect(address.value).toBe("next.example.com");
    fireEvent.submit(address.closest("form"));
    await waitFor(() => expect(browser.command).toHaveBeenCalledWith("real-session-1", "navigate", { url: "https://next.example.com" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "后退" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "后退" }));
    await waitFor(() => expect(browser.command).toHaveBeenCalledWith("real-session-1", "back", {}));
  });

  it("空页先建立 viewport，模态框隐藏，关闭后恢复，切换会话先撤销旧授权", async () => {
    page.hasPage = false;
    mountPanel();
    await waitFor(() => expect(browser.setViewport).toHaveBeenCalledWith({ sessionId: "real-session-1", rect: { x: 400, y: 80, width: 600, height: 420 } }));
    expect(screen.getByTestId("jev-start").disabled).toBe(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    await act(async () => document.body.append(dialog));
    await waitFor(() => expect(browser.setViewport.mock.lastCall[0].rect).toBeNull());
    await act(async () => dialog.remove());
    await waitFor(() => expect(browser.setViewport.mock.lastCall[0].rect).not.toBeNull());
    act(() => useZCodeSessionStore.getState().setActiveTaskId("project:p1", "real-session-2"));
    expect(browser.run).toHaveBeenCalledWith("real-session-1", "revoke", {});
    expect(browser.setViewport).toHaveBeenCalledWith({ sessionId: "real-session-1", rect: null });
    await waitFor(() => expect(browser.command).toHaveBeenCalledWith("real-session-2", "state", {}));
    expect(screen.getByTestId("desktop-browser-panel").dataset.sessionId).toBe("real-session-2");
  });

  it("启动期间立即可停止，revoke 不等待 start 返回，切会话恢复逐步确认", async () => {
    mountPanel();
    await screen.findByDisplayValue("https://example.com");
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("", "config", {}));
    const started = deferred();
    const original = browser.run.getMockImplementation();
    browser.run.mockImplementation((id, op, args) => op === "start" ? started.promise : original(id, op, args));
    fireEvent.change(screen.getByTestId("jev-goal"), { target: { value: "查找资料" } });
    fireEvent.click(screen.getByTestId("jev-confirm-each-action"));
    fireEvent.click(screen.getByTestId("jev-start"));
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("real-session-1", "start", { goal: "查找资料", maxSteps: 20, confirmEachAction: false }));
    expect(screen.getByTestId("jev-confirm-each-action").disabled).toBe(true);
    expect(screen.getByTestId("jev-stop").disabled).toBe(false);
    fireEvent.click(screen.getByTestId("jev-stop"));
    expect(browser.run).toHaveBeenCalledWith("real-session-1", "revoke", {});
    currentRun = { id: "run-1", sessionId: "real-session-1", status: "running", steps: [] };
    await act(async () => started.resolve(currentRun));
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("real-session-1", "stop", { runId: "run-1" }));
    act(() => useZCodeSessionStore.getState().setActiveTaskId("project:p1", "real-session-2"));
    expect(screen.getByTestId("jev-confirm-each-action").checked).toBe(true);
  });

  it.each([true, false])("审批携带身份，中文摘要，固定 footer（approve=%s）", async (approve) => {
    currentRun = { id: "r", sessionId: "real-session-1", status: "awaiting_approval", steps: [], pendingAction: { approvalId: "approval-uuid", kind: "fill", label: "搜索框", text: "浏览器测试" } };
    mountPanel();
    await screen.findByText("输入 · 搜索框");
    expect(screen.getByText("输入内容：浏览器测试")).toBeTruthy();
    expect(screen.getByTestId("browser-run-footer").className).toContain("h-[280px]");
    fireEvent.click(screen.getByTestId(approve ? "jev-approve" : "jev-reject"));
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("real-session-1", "approve", { runId: "r", approve, approvalId: "approval-uuid" }));
  });

  it("桥接重连时刷新配置，无需重开面板", async () => {
    config.bridgeConnected = false;
    mountPanel();
    await screen.findByText("浏览器桥接未连接，请检查桌面服务。");
    config = { ...config, bridgeConnected: true };
    fireEvent(window, new Event("focus"));
    await screen.findByText("jev-latest · 最多 20 步");
  });

  it("隐藏时未返回的 start 在返回后补 stop，清理失败向调用方报告", async () => {
    const controller = createBrowserController(browser, "real-session-1");
    const started = deferred();
    browser.run.mockImplementation(async (id, op) => {
      if (op === "start") return started.promise;
      if (op === "current") return { id: "pending-run", sessionId: id, status: "running" };
      if (op === "stop") throw new Error("停止失败");
      return null;
    });
    const pending = controller.run("start", {});
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("real-session-1", "start", {}));
    const disposed = controller.dispose();
    const assertion = expect(disposed).rejects.toThrow("停止失败");
    expect(browser.run).toHaveBeenCalledWith("real-session-1", "revoke", {});
    expect(browser.setViewport).toHaveBeenCalledWith({ sessionId: "real-session-1", rect: null });
    started.resolve({ id: "pending-run", sessionId: "real-session-1", status: "running" });
    await pending;
    await assertion;
    expect(browser.run).toHaveBeenCalledWith("real-session-1", "stop", { runId: "pending-run" });
  });
});

describe("Jev 设置凭据边界", () => {
  it("读取不回显，保存立即清空密码，不持久化，留空保留密钥", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<JevSettings />);
    await screen.findByText("Jev 密钥已配置");
    const key = screen.getByLabelText("Jev API Key");
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    fireEvent.change(key, { target: { value: "test-secret" } });
    fireEvent.click(screen.getByTestId("jev-save"));
    expect(key.value).toBe("");
    await screen.findByText("Jev 配置已保存");
    expect(browser.run).toHaveBeenCalledWith("", "configure", { model: "jev-latest", apiKey: "test-secret" });
    expect(storage).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("test-secret");
    fireEvent.click(screen.getByTestId("jev-save"));
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("", "configure", { model: "jev-latest" }));
  });

  it("明确勾选才清除密钥，保存错误不反射敏感服务端文本", async () => {
    render(<JevSettings />);
    await screen.findByText("Jev 密钥已配置");
    fireEvent.click(screen.getByTestId("jev-clear-key"));
    fireEvent.click(screen.getByTestId("jev-save"));
    await waitFor(() => expect(browser.run).toHaveBeenCalledWith("", "configure", { model: "jev-latest", clearApiKey: true }));
    await screen.findByText("Jev 配置已保存");
    browser.run.mockRejectedValue(new Error("secret-from-server"));
    fireEvent.change(screen.getByLabelText("Jev API Key"), { target: { value: "secret-from-server" } });
    fireEvent.click(screen.getByTestId("jev-save"));
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("secret-from-server");
    expect(screen.getByLabelText("Jev API Key").value).toBe("");
  });
});
