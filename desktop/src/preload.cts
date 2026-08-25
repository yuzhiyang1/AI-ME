import { contextBridge } from "electron";

// 沙箱模式下使用 CommonJS 预加载脚本，只向渲染层暴露只读的桌面运行上下文。
contextBridge.exposeInMainWorld("aiMeDesktop", {
  mode: "desktop",
  platform: process.platform,
  apiBaseUrl: process.env.AI_ME_API_URL ?? "http://127.0.0.1:8000",
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
