import { BrowserWindow, WebContentsView, type Rectangle } from "electron";
import { randomUUID } from "node:crypto";
import { createPageRuntime } from "./page-runtime.js";
import { BrowserNetworkPolicy, type BrowserHostOptions } from "./security.js";
import {
  EMPTY_STATE, MAX_PAGES, SNAPSHOT_TTL_MS, commandArgs, isWebUrl, requiredString, viewportRect,
  type BrowserAction, type BrowserActResult, type BrowserOperation, type BrowserSnapshot, type BrowserState, type BrowserViewport,
} from "./types.js";

export type { BrowserHostOptions } from "./security.js";
export type { BrowserAction, BrowserOperation, BrowserSnapshot, BrowserState, BrowserViewport, BrowserActResult } from "./types.js";

interface Observed {
  snapshotId: string;
  created: number;
  epoch: number;
  objectId: string;
  actions: Map<string, BrowserAction>;
}

interface Page {
  sessionId: string;
  view: WebContentsView;
  epoch: number;
  cancelVersion: number;
  navigationVersion: number;
  visible: boolean;
  busy: boolean;
  disposed: boolean;
  snapshot?: Observed;
  /** 所有远端运行时对象均由页面持有，失败/隐藏/销毁时也能回收。 */
  objects: Set<string>;
  removeDownloadGuard: () => void;
}

/**
 * 主进程独占的浏览器执行器。调用方负责 IPC 来源、真实业务 session 与动作审批。
 * 这里再次校验可见会话、输入协议、动作编号及文档身份，不信任 renderer 的参数。
 */
export class BrowserHost {
  private readonly pages = new Map<string, Page>();
  private readonly network: BrowserNetworkPolicy;
  private viewport: BrowserViewport | undefined;
  private disposed = false;
  private readonly onWindowClosed = () => this.dispose();
  private readonly onWindowHidden = () => this.hideAll();
  private readonly onWindowResize = () => {
    if (this.viewport) this.setViewport(this.viewport);
  };

  constructor(private readonly mainWindow: BrowserWindow, options: BrowserHostOptions = {}) {
    this.network = new BrowserNetworkPolicy(options.blockedOrigins);
    mainWindow.once("closed", this.onWindowClosed);
    mainWindow.on("hide", this.onWindowHidden);
    mainWindow.on("minimize", this.onWindowHidden);
    mainWindow.on("resize", this.onWindowResize);
  }

  async command(sessionId: string, operation: BrowserOperation | string, args?: unknown): Promise<BrowserState | BrowserSnapshot | BrowserActResult> {
    this.assertAlive();
    requiredString(sessionId, "sessionId");
    const allowed = operation === "navigate" ? ["url"] : operation === "act" ? ["snapshotId", "actionId", "text"] : [];
    const input = commandArgs(args, allowed);
    if (operation === "state") return this.state(this.pages.get(sessionId));
    if (operation === "close") {
      this.closePage(sessionId);
      return { ...EMPTY_STATE };
    }
    if (operation === "stop") {
      const page = this.pages.get(sessionId);
      if (page) { this.invalidate(sessionId); if (!page.disposed) page.view.webContents.stop(); this.emitState(page); }
      return this.state(page);
    }
    if (!["navigate", "back", "forward", "reload", "observe", "act"].includes(operation)) throw new Error("不支持的浏览器操作");

    // 可见资格必须先由可信主入口 setViewport 建立；后台请求不能自行开页或切换会话。
    this.assertViewport(sessionId);
    const url = operation === "navigate" ? this.network.navigation(input.url) : undefined;
    const page = this.pages.get(sessionId) ?? (operation === "navigate" ? this.createPage(sessionId) : undefined);
    if (!page) throw new Error("该会话尚未打开网页");
    this.assertVisible(page);
    // 不排队旧动作：并发请求立即失败，避免审批过的动作在另一条导航结束后才执行。
    if (page.busy) throw new Error("浏览器正在执行操作，请等待完成后重新观察");
    page.busy = true;
    try {
      if (operation === "observe") return await this.observe(page);
      if (operation === "act") return await this.act(page, input);
      this.revokePage(page);
      const wc = page.view.webContents;
      if (operation === "navigate") {
        try { await wc.loadURL(url!); }
        catch { throw new Error("网页加载失败或已被取消，请检查浏览器状态后重试"); }
      } else if (operation === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (operation === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (operation === "reload") wc.reload();
      return this.state(page);
    } finally {
      page.busy = false;
      this.emitState(page);
    }
  }

  setViewport(input: BrowserViewport): void {
    this.assertAlive();
    requiredString(input.sessionId, "sessionId");
    const [width = 0, height = 0] = this.mainWindow.getContentSize();
    const rect = input.rect === null ? null : viewportRect(input.rect, width, height);
    if (rect === null) {
      const page = this.pages.get(input.sessionId);
      if (page) this.hide(page);
      // 已切到 B 后迟到的 A/null 不得把 B 的可见资格撤销。
      if (this.viewport?.sessionId === input.sessionId) this.viewport = undefined;
      return;
    }
    for (const page of this.pages.values()) if (page.sessionId !== input.sessionId) this.hide(page);
    this.viewport = { sessionId: input.sessionId, rect };
    const page = this.pages.get(input.sessionId);
    if (page) this.show(page, rect);
  }

  /** 可供可信主入口在转发 loopback 请求前检查；业务 session 存在性仍由应用验证。 */
  isVisible(sessionId: string): boolean {
    return !this.disposed && this.viewport?.sessionId === sessionId && !!this.viewport.rect
      && !this.mainWindow.isDestroyed() && this.mainWindow.isVisible() && !this.mainWindow.isMinimized();
  }

  /** 同步撤销执行资格；已送达网页的副作用无法回滚，仍在途的命令通过销毁页面取消。 */
  invalidate(sessionId: string): void {
    const page = this.pages.get(sessionId);
    if (!page) return;
    page.cancelVersion++;
    this.revokePage(page);
    if (page.busy) this.closePage(sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewport = undefined;
    this.mainWindow.removeListener("closed", this.onWindowClosed);
    this.mainWindow.removeListener("hide", this.onWindowHidden);
    this.mainWindow.removeListener("minimize", this.onWindowHidden);
    this.mainWindow.removeListener("resize", this.onWindowResize);
    for (const id of [...this.pages.keys()]) this.closePage(id);
  }

  private createPage(sessionId: string): Page {
    if (this.pages.size >= MAX_PAGES) throw new Error(`浏览器最多保留 ${MAX_PAGES} 个页面，请先关闭不用的页面`);
    // 随机且无 persist: 前缀；不同会话、关闭后重开都不共享真实用户的 cookie/profile。
    const view = new WebContentsView({ webPreferences: {
      partition: `aime-browser-${randomUUID()}`, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      webviewTag: false, navigateOnDragDrop: false, safeDialogs: true,
    } });
    view.setVisible(false);
    const page: Page = { sessionId, view, epoch: 0, cancelVersion: 0, navigationVersion: 0, visible: false, busy: false, disposed: false, objects: new Set(), removeDownloadGuard: () => {} };
    try {
      this.securePage(page);
      this.wireEvents(page);
      this.mainWindow.contentView.addChildView(view);
      this.pages.set(sessionId, page);
      if (this.viewport?.sessionId === sessionId && this.viewport.rect) this.show(page, this.viewport.rect);
      this.emitState(page);
      return page;
    } catch (error) {
      this.pages.set(sessionId, page);
      this.closePage(sessionId);
      throw error;
    }
  }

  private securePage(page: Page): void {
    const wc = page.view.webContents;
    const session = wc.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    const denyDownload = (event: Electron.Event) => event.preventDefault();
    session.on("will-download", denyDownload);
    page.removeDownloadGuard = () => session.removeListener("will-download", denyDownload);
    // 包含 fetch、子框架、WebSocket、重定向后的请求；应用 API 不可由网页绕过 IPC 调用。
    session.webRequest.onBeforeRequest((details, callback) => {
      const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      callback({ cancel: page.disposed || !this.network.allows(details.url, navigation) });
    });
    wc.on("will-frame-navigate", (event) => {
      if (!this.network.allows(event.url, true)) event.preventDefault();
    });
    wc.on("will-navigate", (event, url) => {
      if (!this.network.allows(url, true)) event.preventDefault();
    });
    wc.on("will-redirect", (event, url) => {
      if (!this.network.allows(url, true)) event.preventDefault();
    });
    // 始终拒绝新窗口；仅把当前可见页面的安全 http(s) 链接转为本页导航。
    wc.setWindowOpenHandler(({ url }) => {
      if (this.isVisible(page.sessionId) && this.network.allows(url, true)) {
        this.revokePage(page);
        void wc.loadURL(url).catch(() => this.emitState(page));
      }
      return { action: "deny" };
    });
    wc.on("will-attach-webview", (event) => event.preventDefault());
  }

  private wireEvents(page: Page): void {
    const wc = page.view.webContents;
    wc.on("did-start-loading", () => this.emitState(page));
    wc.on("did-stop-loading", () => this.emitState(page));
    wc.on("page-title-updated", () => this.emitState(page));
    wc.on("did-fail-load", () => this.emitState(page));
    // 任何 frame 导航都会改变观察上下文；同文档导航也不保留旧审批。
    const navigated = () => { page.navigationVersion++; this.revokePage(page); this.emitState(page); };
    wc.on("did-start-navigation", navigated);
    wc.on("did-navigate-in-page", navigated);
    wc.on("did-navigate", navigated);
    wc.on("render-process-gone", () => this.closePage(page.sessionId, page));
    wc.once("destroyed", () => this.closePage(page.sessionId, page));
    wc.debugger.on("detach", () => this.revokePage(page));
  }

  private async observe(page: Page): Promise<BrowserSnapshot> {
    const cancelVersion = page.cancelVersion;
    const deadline = Date.now() + 10_000;
    // 点击的 CDP 回包可能先于 did-start-navigation 到达；只有只读 observe 可跨正常导航重试。
    while (true) {
      await this.waitUntilReadable(page, cancelVersion, deadline);
      this.assertNotCanceled(page, cancelVersion);
      const navigationVersion = page.navigationVersion;
      try {
        const result = await this.observeDocument(page);
        this.assertNotCanceled(page, cancelVersion);
        return result;
      }
      catch (error) {
        this.assertNotCanceled(page, cancelVersion);
        if (Date.now() >= deadline || (page.navigationVersion === navigationVersion && !page.view.webContents.isLoadingMainFrame())) throw error;
      }
    }
  }

  private async observeDocument(page: Page): Promise<BrowserSnapshot> {
    this.assertReadable(page);
    this.revokePage(page);
    const epoch = page.epoch;
    const wc = page.view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const tree = await this.cdp(page, "Page.getFrameTree") as { frameTree: { frame: { id: string } } };
    this.assertEpoch(page, epoch);
    const world = await this.cdp(page, "Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id, worldName: "aime-browser-observer", grantUniveralAccess: false,
    }) as { executionContextId: number };
    this.assertEpoch(page, epoch);
    const remote = await this.cdp(page, "Runtime.evaluate", {
      expression: `(${createPageRuntime.toString()})()`, contextId: world.executionContextId,
      returnByValue: false, objectGroup: "aime-observation",
    }) as RuntimeResponse;
    this.checkRuntime(remote);
    const objectId = remote.result?.objectId;
    if (!objectId) throw new Error("无法创建浏览器快照运行时");
    page.objects.add(objectId);
    try {
      this.assertEpoch(page, epoch);
      const snapshotId = randomUUID();
      const snapshot = await this.callRuntime(page, objectId, "observe", [snapshotId]) as BrowserSnapshot;
      this.assertEpoch(page, epoch);
      this.assertReadable(page);
      page.snapshot = { snapshotId, objectId, created: Date.now(), epoch, actions: new Map(snapshot.actions.map((action) => [action.id, { ...action }])) };
      return snapshot;
    } catch (error) {
      this.releaseRuntime(page, objectId);
      throw error;
    }
  }

  private async act(page: Page, input: Record<string, unknown>): Promise<BrowserActResult> {
    this.assertReadable(page);
    const snapshotId = requiredString(input.snapshotId, "snapshotId");
    const actionId = requiredString(input.actionId, "actionId");
    const observed = page.snapshot;
    const action = observed?.actions.get(actionId);
    if (!observed || observed.snapshotId !== snapshotId || observed.epoch !== page.epoch || Date.now() - observed.created > SNAPSHOT_TTL_MS || !action) {
      throw new Error("动作或快照已失效，请重新观察");
    }
    if (action.kind === "fill") {
      if (typeof input.text !== "string" || input.text.length > 20_000) throw new Error("填写动作需要不超过 20000 字符的 text");
    } else if (input.text !== undefined) throw new Error("只有填写动作接受 text；选择/滚动使用已观察的值");
    page.snapshot = undefined;
    const cancelVersion = page.cancelVersion;
    try {
      this.assertEpoch(page, observed.epoch);
      // objectId 绑定旧 document；导航后 CDP 会拒绝旧引用，绝不在新文档查找同名节点。
      let result: { ok: true; waitMs?: number };
      try {
        result = await this.callRuntime(page, observed.objectId, "act", [snapshotId, actionId, input.text]) as { ok: true; waitMs?: number };
      } catch (error) {
        this.assertNotCanceled(page, cancelVersion);
        // 已发送动作后发生导航，无法证明副作用是否完成；不重试，也不伪造确定失败。
        if (page.epoch !== observed.epoch) return { ok: true, outcome: "uncertain", snapshotId, actionId, state: this.state(page) };
        throw error;
      }
      this.assertNotCanceled(page, cancelVersion);
      if (result.waitMs) {
        await new Promise((resolve) => setTimeout(resolve, result.waitMs));
        this.assertNotCanceled(page, cancelVersion);
      }
      this.assertVisible(page);
      return { ok: true, outcome: "completed", snapshotId, actionId, state: this.state(page) };
    } finally {
      this.releaseRuntime(page, observed.objectId);
    }
  }

  private async callRuntime(page: Page, objectId: string, method: "observe" | "act", values: unknown[]): Promise<unknown> {
    const response = await this.cdp(page, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: method === "observe" ? "function(id) { return this.observe(id); }" : "function(id, action, text) { return this.act(id, action, text); }",
      arguments: values.map((value) => value === undefined ? {} : { value }),
      returnByValue: true, userGesture: method === "act",
    }) as RuntimeResponse;
    this.checkRuntime(response);
    return response.result?.value;
  }

  private checkRuntime(response: RuntimeResponse): void {
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "网页快照执行失败");
  }

  private async cdp(page: Page, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (page.disposed || page.view.webContents.isDestroyed()) throw new Error("浏览器页面已关闭");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.view.webContents.debugger.sendCommand(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // 超时的 CDP 不能安全取消单条命令；销毁页面，杜绝超时后继续产生副作用。
            this.closePage(page.sessionId, page);
            reject(new Error("浏览器执行超时，页面已关闭以取消未完成操作"));
          }, 10_000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private revokePage(page: Page): void {
    page.epoch++;
    page.snapshot = undefined;
    for (const objectId of [...page.objects]) this.releaseRuntime(page, objectId);
  }

  private releaseRuntime(page: Page, objectId: string): void {
    if (!page.objects.delete(objectId)) return;
    const wc = page.view.webContents;
    if (wc.isDestroyed() || !wc.debugger.isAttached()) return;
    // 每个 promise 都接住导航/销毁造成的拒绝，清理不能成为 unhandled rejection。
    void wc.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId, functionDeclaration: "function() { this.revoke(); }", returnByValue: true,
    }).catch(() => {}).finally(() => {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) void wc.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    });
  }

  private show(page: Page, rect: Rectangle): void {
    const previous = page.view.getBounds();
    if (previous.x !== rect.x || previous.y !== rect.y || previous.width !== rect.width || previous.height !== rect.height) this.invalidate(page.sessionId);
    if (page.disposed) return;
    page.view.setBounds(rect);
    page.view.setVisible(true);
    page.visible = true;
  }

  private hide(page: Page): void {
    if (!page.visible) return;
    page.cancelVersion++;
    this.revokePage(page);
    page.visible = false;
    page.view.setVisible(false);
    // 已派发的同步 DOM 动作不可撤回；切换期间关闭正在执行的页面，阻止迟到动作落在隐藏页。
    if (page.busy) this.closePage(page.sessionId, page);
  }

  private hideAll(): void {
    this.viewport = undefined;
    for (const page of this.pages.values()) this.hide(page);
  }

  private closePage(sessionId: string, expected?: Page): void {
    const page = this.pages.get(sessionId);
    if (!page || (expected && page !== expected)) return;
    this.pages.delete(sessionId);
    page.disposed = true;
    page.cancelVersion++;
    this.revokePage(page);
    const wc = page.view.webContents;
    const session = wc.session;
    try { if (!this.mainWindow.isDestroyed()) this.mainWindow.contentView.removeChildView(page.view); } catch { /* 窗口可能已进入销毁流程。 */ }
    try { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); } catch { /* 已关闭的页面无需再次关闭。 */ }
    page.removeDownloadGuard();
    session.webRequest.onBeforeRequest(null);
    // 清空临时会话的数据；不触碰应用工作台或用户持久 profile。
    void session.clearStorageData().catch(() => {});
    void session.clearCache().catch(() => {});
    void session.closeAllConnections().catch(() => {});
    this.emitState(page);
  }

  private state(page?: Page): BrowserState {
    if (!page || page.disposed || page.view.webContents.isDestroyed()) return { ...EMPTY_STATE };
    const wc = page.view.webContents;
    const url = wc.getURL();
    return { url, title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), loading: wc.isLoading(), hasPage: isWebUrl(url) };
  }

  private emitState(page: Page): void {
    if (this.mainWindow.isDestroyed() || this.mainWindow.webContents.isDestroyed()) return;
    const current = this.pages.get(page.sessionId);
    if (current && current !== page) return;
    this.mainWindow.webContents.send("browser:state", { sessionId: page.sessionId, state: this.state(page) });
  }

  private assertAlive(): void {
    if (this.disposed || this.mainWindow.isDestroyed()) throw new Error("浏览器宿主已关闭");
  }

  private assertViewport(sessionId: string): void {
    if (!this.isVisible(sessionId)) throw new Error("只能操作当前可见会话的浏览器");
  }

  private assertVisible(page: Page): void {
    this.assertViewport(page.sessionId);
    if (page.disposed || !page.visible || page.view.webContents.isDestroyed()) throw new Error("浏览器页面已隐藏或关闭");
  }

  private assertReadable(page: Page): void {
    this.assertVisible(page);
    if (!this.state(page).hasPage || page.view.webContents.isLoadingMainFrame()) throw new Error("网页尚未加载完成，请稍后重新观察");
  }

  /** 正常导航可推进文档 epoch；显式撤销的 cancelVersion 绝不随等待重新捕获。 */
  private async waitUntilReadable(page: Page, cancelVersion: number, deadline: number): Promise<void> {
    this.assertNotCanceled(page, cancelVersion);
    while (page.view.webContents.isLoadingMainFrame()) {
      if (Date.now() >= deadline) throw new Error("等待网页加载超时，请稍后重新观察");
      await new Promise((resolve) => setTimeout(resolve, 25));
      this.assertNotCanceled(page, cancelVersion);
    }
  }

  private assertNotCanceled(page: Page, cancelVersion: number): void {
    this.assertVisible(page);
    if (page.cancelVersion !== cancelVersion) throw new Error("浏览器操作已撤销，请重新观察");
  }

  private assertEpoch(page: Page, epoch: number): void {
    this.assertVisible(page);
    if (page.epoch !== epoch) throw new Error("浏览器页面或可见范围已变化，请重新观察");
  }
}

interface RuntimeResponse {
  result?: { objectId?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}
