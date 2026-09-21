import { contextBridge, ipcRenderer } from "electron";

// 订阅函数只传业务数据，不把 Electron event 暴露给网页；卸载时移除同一监听器。
function subscribe<T>(
  channel: string,
  listener: (payload: T) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) =>
    listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// 沙箱模式下使用 CommonJS 预加载脚本，只向渲染层暴露只读的桌面运行上下文。
contextBridge.exposeInMainWorld("aiMeDesktop", {
  mode: "desktop",
  platform: process.platform,
  apiBaseUrl: process.env.AI_ME_API_URL ?? "http://127.0.0.1:8000",
  // 目录选择由主进程执行，渲染层只得到用户明确选中的路径。
  selectWorkspace: (): Promise<string | null> =>
    ipcRenderer.invoke("workspace:select"),
  executeDesktopCommand: (command: string) =>
    ipcRenderer.invoke("window:command", command),
  getDesktopWindowChromeState: () => ipcRenderer.invoke("window:state"),
  getDesktopZoomLevel: () => ipcRenderer.invoke("window:zoom"),
  onDesktopWindowChromeStateChanged: (listener: (state: unknown) => void) =>
    subscribe("window:state-changed", listener),
  onDesktopZoomLevelChanged: (listener: (state: unknown) => void) =>
    subscribe("window:zoom-changed", listener),
  onWindowFullscreenChanged: (listener: (fullscreen: boolean) => void) =>
    subscribe("window:fullscreen-changed", listener),
  onWindowAction: (listener: (command: string) => void) =>
    subscribe("window:action", listener),
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
