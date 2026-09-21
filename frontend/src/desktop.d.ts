export {};

/** 由 Electron 持有的每会话单页快照，不包含 DOM 或凭据。 */
export interface DesktopBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  hasPage: boolean;
}
export interface JevConfig {
  configured: boolean;
  model: string;
  textConfigured: boolean;
  bridgeConnected: boolean;
}
export interface JevRun {
  id: string;
  sessionId: string;
  status: "running" | "awaiting_approval" | "stopped" | "failed" | "needs_verification" | "blocked";
  goal: string;
  /** 后端动作/观察记录原样展示；当前契约未固定记录内部字段。 */
  steps: unknown[];
  pendingAction?: { approvalId: string; kind?: string; label?: string; text?: string; [key: string]: unknown };
  error?: string | null;
}
export interface DesktopBrowserBridge {
  command(sessionId: string, operation: "navigate", args: { url: string }): Promise<DesktopBrowserState>;
  command(sessionId: string, operation: "back" | "forward" | "reload" | "stop" | "close" | "state", args?: Record<string, never>): Promise<DesktopBrowserState>;
  /** rect 为 renderer CSS 像素；null 撤下原生层，缩放转换由 Electron 负责。 */
  setViewport(input: { sessionId: string; rect: { x: number; y: number; width: number; height: number } | null }): Promise<unknown>;
  onState(callback: (event: { sessionId: string; state: DesktopBrowserState }) => void): () => void;
  /** 后端 Agent 请求展开当前聊天，不允许后台会话抢占可见页面。 */
  onOpenRequest?(callback: (event: { sessionId: string }) => void): () => void;
  /** 临时凭据仅进入主进程内存；响应中不含 value。 */
  credential?(sessionId: string, input: { name: string; origin: string; value: string } | { clear: true }): Promise<{ name?: string; origin?: string; cleared?: boolean }>;
  /** 配置操作使用空 sessionId；不返回已保存的密钥。 */
  run(sessionId: string, operation: "config", args?: Record<string, never>): Promise<JevConfig>;
  run(sessionId: string, operation: "configure", args: { apiKey?: string; model: string; clearApiKey?: boolean }): Promise<JevConfig>;
  run(sessionId: string, operation: "start", args: { goal: string; maxSteps: 20; confirmEachAction: boolean; textModelRef?: string }): Promise<JevRun>;
  /** 主进程立即撤销执行授权，不依赖后端网络请求。 */
  run(sessionId: string, operation: "revoke", args?: Record<string, never>): Promise<unknown>;
  run(sessionId: string, operation: "current", args?: Record<string, never>): Promise<JevRun | null>;
  run(sessionId: string, operation: "stop", args: { runId: string }): Promise<JevRun>;
  run(sessionId: string, operation: "approve", args: { runId: string; approve: boolean; approvalId: string }): Promise<JevRun>;
}

declare global {
  interface Window {
    /** Electron 预加载脚本提供的最小桌面运行上下文。 */
    aiMeDesktop?: {
      mode: "desktop";
      platform: string;
      apiBaseUrl: string;
      /** 可选，旧桌面 preload 与普通 Web 不启用浏览器入口。 */
      browser?: DesktopBrowserBridge;
      selectWorkspace: () => Promise<string | null>;
      /** 仅执行主进程白名单内的窗口命令。 */
      executeDesktopCommand: (command: string) => Promise<void>;
      getDesktopWindowChromeState: () => Promise<{
        isMaximized: boolean;
        supportsNativeRoundedCorners: boolean;
        macOSMajorVersion: number | null;
      }>;
      getDesktopZoomLevel: () => Promise<{ zoomLevel: number }>;
      onDesktopWindowChromeStateChanged: (
        listener: (state: {
          isMaximized: boolean;
          supportsNativeRoundedCorners: boolean;
        }) => void,
      ) => () => void;
      onDesktopZoomLevelChanged: (
        listener: (state: { zoomLevel: number }) => void,
      ) => () => void;
      onWindowFullscreenChanged: (
        listener: (fullscreen: boolean) => void,
      ) => () => void;
      onWindowAction: (listener: (command: string) => void) => () => void;
      versions: {
        chrome?: string;
        electron?: string;
      };
    };
  }
}
