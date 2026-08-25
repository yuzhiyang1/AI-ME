import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentRendererUrl = process.env.AI_ME_RENDERER_URL;

function isAllowedInAppNavigation(targetUrl: string): boolean {
  if (!developmentRendererUrl) {
    return targetUrl.startsWith("file://");
  }

  return new URL(targetUrl).origin === new URL(developmentRendererUrl).origin;
}

async function createMainWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#F6F6F8",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#FBFBFC",
      symbolColor: "#5F6170",
      height: 40,
    },
    show: false,
    webPreferences: {
      // 渲染层只通过预加载脚本访问受控的桌面能力，避免直接暴露 Node.js。
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

  // 未设置开发地址时读取已构建的共享渲染层，便于本地生产模式验证。
  const rendererEntry = path.resolve(currentDirectory, "../../frontend/dist/index.html");
  await mainWindow.loadFile(rendererEntry);
}

app.whenReady().then(async () => {
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
