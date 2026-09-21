/** 普通浏览器不得冒充桌面；Windows 桌面身份与主进程无边框配置必须一起启用。 */
export function desktopRootProps(bridge) {
  const isDesktop = bridge?.mode === "desktop" && bridge.platform === "win32";
  return { isDesktop, isWindowsDesktop: isDesktop, isMacDesktop: false };
}

export function desktopPlatform(bridge) {
  if (!desktopRootProps(bridge).isDesktop) return {};
  const onAction = (action) => (listener) =>
    bridge.onWindowAction((command) => {
      if (command === action) listener();
    });
  return {
    executeDesktopCommand: (command) => bridge.executeDesktopCommand(command),
    getDesktopWindowChromeState: () => bridge.getDesktopWindowChromeState(),
    onDesktopWindowChromeStateChanged: (listener) =>
      bridge.onDesktopWindowChromeStateChanged(listener),
    getDesktopZoomLevel: () => bridge.getDesktopZoomLevel(),
    onDesktopZoomLevelChanged: (listener) =>
      bridge.onDesktopZoomLevelChanged(listener),
    onWindowFullscreenChanged: (listener) =>
      bridge.onWindowFullscreenChanged(listener),
    // 与原版自绘 Windows 控件一致：按钮随 renderer 缩放，安全区保持固定 CSS 像素。
    getWindowControlsOverlayMetrics: () => ({
      rightPaddingPx: 136,
      titleBarHeightPx: 48,
    }),
    onNewTask: onAction("newTask"),
    onNewTab: onAction("newTab"),
    onOpenWorkspace: onAction("openWorkspace"),
    onCloseActiveContextRequest: onAction("closeActiveContext"),
  };
}
