import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import os from "node:os";

/** 仅操作发起请求的本地工作台窗口，不向 renderer 暴露任意 IPC 或主进程对象。 */
export function registerWindowChrome(
  isAllowedUrl: (url: string) => boolean,
): void {
  function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (
      !window ||
      window.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !isAllowedUrl(event.senderFrame.url)
    ) {
      throw new Error("不允许此页面控制桌面窗口");
    }
    return window;
  }

  ipcMain.handle("window:state", (event) =>
    readWindowState(senderWindow(event)),
  );
  ipcMain.handle("window:zoom", (event) => ({
    zoomLevel: senderWindow(event).webContents.getZoomLevel(),
  }));
  ipcMain.handle("window:command", (event, command: unknown) => {
    const window = senderWindow(event);
    switch (command) {
      case "minimizeWindow":
        window.minimize();
        break;
      case "toggleMaximizeWindow":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "closeWindow":
        window.close();
        break;
      case "toggleFullScreen":
        window.setFullScreen(!window.isFullScreen());
        break;
      case "resetWindowSize":
        window.unmaximize();
        window.setSize(1440, 900);
        window.center();
        break;
      case "zoomIn":
      case "zoomOut":
      case "resetZoom": {
        const level =
          command === "resetZoom"
            ? 0
            : window.webContents.getZoomLevel() +
              (command === "zoomIn" ? 0.5 : -0.5);
        window.webContents.setZoomLevel(Math.max(-2, Math.min(3, level)));
        window.webContents.send("window:zoom-changed", {
          zoomLevel: window.webContents.getZoomLevel(),
        });
        break;
      }
      case "newTask":
      case "openWorkspace":
      case "closeActiveContext":
        window.webContents.send("window:action", command);
        break;
      default:
        throw new Error(`AI-ME 尚未接入桌面命令：${String(command)}`);
    }
  });
}

export function readWindowState(window: BrowserWindow) {
  // Windows 11（build 22000 起）支持系统外沿圆角；不能将 Win10 误报为 Win11。
  const build = Number(os.release().split(".")[2] ?? 0);
  return {
    isMaximized: window.isMaximized(),
    supportsNativeRoundedCorners:
      process.platform === "win32" && build >= 22000,
    macOSMajorVersion: null,
  };
}

export function bindWindowChrome(window: BrowserWindow): void {
  const publishState = () => {
    if (!window.isDestroyed())
      window.webContents.send("window:state-changed", readWindowState(window));
  };
  window.on("maximize", publishState);
  window.on("unmaximize", publishState);
  const publishFullscreen = () => {
    window.webContents.send("window:fullscreen-changed", window.isFullScreen());
    publishState();
  };
  window.on("enter-full-screen", publishFullscreen);
  window.on("leave-full-screen", publishFullscreen);
  // 启用 desktop 入口后原版不再安装 Web 快捷键，宿主必须接管 Ctrl+N/O。
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || input.shift)
      return;
    const action = { n: "newTask", o: "openWorkspace" }[
      input.key.toLowerCase()
    ];
    if (!action) return;
    event.preventDefault();
    window.webContents.send("window:action", action);
  });
}
