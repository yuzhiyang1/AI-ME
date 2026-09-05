import { contextBridge, ipcRenderer } from "electron";

// 沙箱模式下使用 CommonJS 预加载脚本，只向渲染层暴露只读的桌面运行上下文。
contextBridge.exposeInMainWorld("aiMeDesktop", {
  mode: "desktop",
  platform: process.platform,
  apiBaseUrl: process.env.AI_ME_API_URL ?? "http://127.0.0.1:8000",
  // 目录选择由主进程执行，渲染层只得到用户明确选中的路径。
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("workspace:select"),
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
