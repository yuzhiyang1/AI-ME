import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindWindowChrome, registerWindowChrome } from "./window-chrome.js";
import { bindBrowserIntegration } from "./browser-integration.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentRendererUrl = process.env.AI_ME_RENDERER_URL;
const apiBaseUrl = process.env.AI_ME_API_URL ?? "http://127.0.0.1:8000";

function isAllowedInAppNavigation(targetUrl: string): boolean {
  if (!developmentRendererUrl) {
    return new URL(targetUrl).origin === new URL(apiBaseUrl).origin;
  }

  return new URL(targetUrl).origin === new URL(developmentRendererUrl).origin;
}

async function createMainWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: process.platform === "win32" ? "#141414" : "#F6F6F8",
    autoHideMenuBar: true,
    // Windows 使用 ZCode 原版 renderer 窗控，不能叠加旧的原生浅色按钮。
    ...(process.platform === "win32"
      ? { frame: false }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#FBFBFC",
            symbolColor: "#5F6170",
            height: 40,
          },
        }),
    show: false,
    webPreferences: {
      // 渲染层只通过预加载脚本访问受控的桌面能力，避免直接暴露 Node.js。
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  bindWindowChrome(mainWindow);
  bindBrowserIntegration(mainWindow, apiBaseUrl, isAllowedInAppNavigation);

  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 外部链接交给系统浏览器，工作台窗口只承载 AI-ME 自身页面。
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedInAppNavigation(url)) {
      event.preventDefault();
    }
  });

  if (developmentRendererUrl) {
    await mainWindow.loadURL(developmentRendererUrl);
    return;
  }

  // 生产模式从本地后端同源加载页面，让渲染层无需获得额外跨域权限。
  await mainWindow.loadURL(`${apiBaseUrl}/app/`);
}

app.whenReady().then(async () => {
  registerWindowChrome(isAllowedInAppNavigation);
  ipcMain.handle("workspace:select", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 AI-ME 会话工作区",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
