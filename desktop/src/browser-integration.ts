import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { BrowserHost } from "./browser/host.js";
import { BrowserCredentials } from './browser/credentials.js';

/** 主进程持有桌面令牌；网页和工作台 renderer 都不能读取它。 */
export function bindBrowserIntegration(window: BrowserWindow, apiBase: string, allowed: (url: string) => boolean) {
  const host = new BrowserHost(window, {
    blockedOrigins: [apiBase, process.env.AI_ME_RENDERER_URL].filter((value): value is string => Boolean(value)),
  });
  const token = process.env.AIME_BROWSER_BRIDGE_TOKEN;
  const base = new URL(apiBase);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error("浏览器执行桥只允许连接本机后端");
  }
  let socket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let visibleSession: string | undefined;
  let viewportRevision = 0;
  const executingSessions = new Set<string>();
  const runs = new Map<string, Promise<string>>();
  const credentials = new BrowserCredentials();
  const toolRequests = new Map<string, { sessionId: string; canceled: boolean }>();

  function revoke(id: string) {
    for (const pending of toolRequests.values()) if (pending.sessionId === id) pending.canceled = true;
    executingSessions.delete(id);
    runs.delete(id);
    host.invalidate(id);
  }

  function owner(event: IpcMainInvokeEvent) {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !allowed(event.senderFrame.url)) {
      throw new Error("此页面不能控制工作台浏览器");
    }
  }
  function sessionId(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('无效的浏览器会话');
    return value;
  }
  async function request(route: string, body?: unknown) {
    if (!token) throw new Error('请通过 npm run dev 或 npm start 启动浏览器执行桥');
    const response = await fetch(new URL(route, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // 后端返回受控的业务错误，不回传请求头和密钥。
      const error = await response.json().catch(() => ({})) as { detail?: unknown };
      throw new Error(typeof error.detail === 'string' ? error.detail : `浏览器请求失败 (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function stopRun(id: string) {
    if (!token) return;
    const run = await request(`/api/browser/sessions/${id}/runs/current`) as { id?: string; status?: string } | null;
    if (run?.id && ['running', 'awaiting_approval'].includes(run.status ?? '')) {
      await request(`/api/browser/sessions/${id}/runs/${encodeURIComponent(run.id)}/stop`, {});
    }
  }

  // 仅显式的白名单命令能穿过 IPC；observe/act 只接受已认证后端的消息。
  ipcMain.handle('browser:credential', (event, rawId: unknown, input: Record<string, unknown>) => {
    owner(event);
    const id = sessionId(rawId);
    if (visibleSession !== id) throw new Error('只能为当前可见会话配置凭据');
    if (input?.clear === true) { credentials.clear(id); return { cleared: true }; }
    return credentials.save(id, input ?? {});
  });
  ipcMain.handle('browser:command', async (event, rawId: unknown, operation: unknown, args: unknown) => {
    owner(event);
    const id = sessionId(rawId);
    if (typeof operation !== 'string' || !['navigate', 'back', 'forward', 'reload', 'stop', 'close', 'state'].includes(operation)) throw new Error('不支持的浏览器命令');
    if (operation !== 'state') {
      revoke(id);
      if (operation === 'close') credentials.clear(id);
      const response = await fetch(new URL(`/api/sessions/${id}`, base), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('会话不存在，请先创建会话');
      await stopRun(id);
    }
    return host.command(id, operation, args ?? {});
  });
  ipcMain.handle('browser:viewport', (event, input: { sessionId: unknown; rect: unknown }) => {
    owner(event);
    const id = sessionId(input?.sessionId);
    viewportRevision++;
    // 隐藏立即撤销执行能力，不等待网络停止请求。
    const rect = input.rect as Parameters<BrowserHost['setViewport']>[0]['rect'];
    const zoom = window.webContents.getZoomFactor();
    host.setViewport({ sessionId: id, rect: rect === null ? null : {
      x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
    } });
    const previous = visibleSession;
    visibleSession = input.rect ? id : (previous === id ? undefined : previous);
    if (previous && previous !== visibleSession) {
      revoke(previous);
      void stopRun(previous).catch(() => {});
    }
  });
  ipcMain.handle('browser:run', async (event, rawId: unknown, operation: string, args: Record<string, unknown> = {}) => {
    owner(event);
    if (operation === 'config') return request('/api/browser/config');
    if (operation === 'configure') return request('/api/browser/config', args);
    const id = sessionId(rawId);
    const route = `/api/browser/sessions/${id}/runs`;
    if (operation === 'revoke') {
      revoke(id);
      return null;
    }
    if (operation === 'current') {
      const current = await request(`${route}/current`) as { id: string; status: string } | null;
      const identity = runs.get(id);
      if (current && !['running', 'awaiting_approval'].includes(current.status) && await identity === current.id && runs.get(id) === identity) revoke(id);
      return current;
    }
    if (operation === 'start') {
      if (visibleSession !== id || !host.isVisible(id) || socket?.readyState !== WebSocket.OPEN) throw new Error('请先打开当前会话的浏览器页面，等待执行桥连接');
      if (executingSessions.has(id) || [...toolRequests.values()].some(item => item.sessionId === id)) throw new Error('当前浏览器任务仍在运行，请先停止');
      host.invalidate(id);
      executingSessions.add(id);
      const started = request(route, args) as Promise<{ id: string }>;
      const identity = started.then((run) => run.id);
      runs.set(id, identity);
      // WebSocket 的首个观察可能早于 HTTP 响应；执行端等待确切 runId。
      void identity.catch(() => {});
      try { return await started; }
      catch (error) { if (runs.get(id) === identity) revoke(id); throw error; }
    }
    const runId = sessionId(args.runId);
    if (operation === 'stop') {
      revoke(id);
      return request(`${route}/${runId}/stop`, {});
    }
    if (operation === 'approve') return request(`${route}/${runId}/approve`, { approve: args.approve, approvalId: args.approvalId });
    throw new Error('不支持的浏览器任务操作');
  });

  function connect() {
    if (!token || disposed) return;
    const endpoint = new URL('/api/browser/bridge', base);
    endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(endpoint, ['aime-browser', `token.${token}`]);
    socket = connection;
    connection.addEventListener('message', async (event) => {
      let id: string | undefined;
      try {
        if (typeof event.data !== 'string' || event.data.length > 64_000) throw new Error('无效的执行桥消息');
        const command = JSON.parse(event.data);
        id = sessionId(command.id);
        const target = sessionId(command.sessionId);
        if (command.operation === 'cancel' && toolRequests.has(command.arguments?.requestId)) {
          const pending = toolRequests.get(command.arguments.requestId)!;
          if (pending.sessionId === target) { pending.canceled = true; host.invalidate(target); }
          connection.send(JSON.stringify({ id, result: { canceled: true } }));
          return;
        }
        if (command.operation === 'tool') {
          if (executingSessions.has(target) || [...toolRequests.values()].some(item => item.sessionId === target)) throw new Error('浏览器已有任务在执行');
          const pending = { sessionId: target, canceled: false };
          toolRequests.set(id, pending);
          try {
            // 前端只为当前聊天展开面板；后台会话的请求不会切走用户当前任务。
            if (visibleSession !== target) window.webContents.send('browser:open-request', { sessionId: target });
            const deadline = Date.now() + 4000;
            while (visibleSession !== target && !pending.canceled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
            // 面板展开/审批收起有布局动画；等坐标稳定后才派发，避免导航期间被 resize 撤销。
            let revision = viewportRevision;
            let stableSince = Date.now();
            while (Date.now() - stableSince < 200 && !pending.canceled && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 25));
              if (revision !== viewportRevision) { revision = viewportRevision; stableSince = Date.now(); }
            }
            if (pending.canceled || visibleSession !== target || connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('当前聊天浏览器不可见或操作已取消');
            const { name, origin, args } = command.arguments ?? {};
            if (!['navigate', 'snapshot', 'click', 'type', 'wait', 'extract'].includes(name) || typeof origin !== 'string' || !args || typeof args !== 'object') throw new Error('无效浏览器工具');
            const result = await host.tool(target, name, origin, args, key => credentials.resolve(target, key, origin));
            if (!pending.canceled && connection.readyState === WebSocket.OPEN) {
              connection.send(JSON.stringify({ id, result: credentials.redact(target, result) }));
            } else throw new Error('浏览器操作已取消');
          } finally { toolRequests.delete(id); }
          return;
        }
        const identity = runs.get(target);
        const runId = await identity;
        if (command.operation === 'cancel') {
          // 旧任务取消可幂等确认，但绝不能撤销新任务。
          if (runId && command.arguments?.runId === runId && runs.get(target) === identity) revoke(target);
          connection.send(JSON.stringify({ id, result: { canceled: true } }));
          return;
        }
        if (!runId || command.arguments?.runId !== runId || runs.get(target) !== identity) throw new Error('浏览器任务已变更，旧操作已撤销');
        if (!['navigate', 'observe', 'act', 'close'].includes(command.operation)) throw new Error('不支持的执行桥操作');
        if (target !== visibleSession) throw new Error('浏览器会话当前不可见，操作已撤销');
        if (!executingSessions.has(target)) throw new Error('浏览器任务已停止，操作已撤销');
        const { runId: _runId, ...argumentsForPage } = command.arguments ?? {};
        const result = await host.command(target, command.operation, argumentsForPage);
        if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id, result }));
      } catch (error) {
        if (id && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id, error: error instanceof Error ? error.message : '浏览器执行失败' }));
      }
    });
    connection.addEventListener('error', () => { connection.close(); });
    connection.addEventListener('close', () => {
      for (const pending of toolRequests.values()) { pending.canceled = true; host.invalidate(pending.sessionId); }
      if (disposed) return;
      // 连接断开撤销执行，保留可见页面供人工核验；重连不会恢复旧任务。
      if (visibleSession) {
        revoke(visibleSession);
      }
      reconnect = setTimeout(connect, 1500);
    });
  }
  connect();
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame && visibleSession) {
      const id = visibleSession;
      revoke(id);
      host.setViewport({ sessionId: id, rect: null });
      visibleSession = undefined;
      void stopRun(id).catch(() => {});
    }
  });
  window.on('closed', () => {
    disposed = true;
    clearTimeout(reconnect);
    socket?.close();
    host.dispose();
    credentials.clear();
    for (const channel of ['browser:command', 'browser:viewport', 'browser:run', 'browser:credential']) ipcMain.removeHandler(channel);
  });
}
