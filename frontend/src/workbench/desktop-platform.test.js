import { describe, expect, it, vi } from "vitest";
import { desktopPlatform, desktopRootProps } from "./desktop-platform.js";

describe("原版 Windows 标题栏接入", () => {
  it("只有真实 Windows 桌面桥才启用自绘窗控，不改变浏览器与其他平台", () => {
    expect(desktopRootProps(undefined).isDesktop).toBe(false);
    expect(
      desktopRootProps({ mode: "desktop", platform: "darwin" }).isDesktop,
    ).toBe(false);
    expect(desktopRootProps({ mode: "desktop", platform: "win32" })).toEqual({
      isDesktop: true,
      isWindowsDesktop: true,
      isMacDesktop: false,
    });
  });

  it("窗口命令与状态走 preload 桥，不伪造成功", async () => {
    const bridge = {
      mode: "desktop",
      platform: "win32",
      executeDesktopCommand: vi.fn().mockResolvedValue(undefined),
      getDesktopWindowChromeState: vi
        .fn()
        .mockResolvedValue({ isMaximized: true }),
    };
    const platform = desktopPlatform(bridge);
    await platform.executeDesktopCommand("toggleMaximizeWindow");
    expect(bridge.executeDesktopCommand).toHaveBeenCalledWith(
      "toggleMaximizeWindow",
    );
    expect(await platform.getDesktopWindowChromeState()).toEqual({
      isMaximized: true,
    });
    expect(platform.getWindowControlsOverlayMetrics().rightPaddingPx).toBe(136);
  });

  it("打开工作区只触发一次；卸载订阅不遗留监听器", () => {
    const listeners = new Set();
    const platform = desktopPlatform({
      mode: "desktop",
      platform: "win32",
      onWindowAction: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const open = vi.fn();
    const newTab = vi.fn();
    const disposeOpen = platform.onOpenWorkspace(open);
    const disposeTab = platform.onNewTab(newTab);
    for (const listener of listeners) listener("openWorkspace");
    expect(open).toHaveBeenCalledTimes(1);
    expect(newTab).not.toHaveBeenCalled();
    disposeOpen();
    disposeTab();
    expect(listeners.size).toBe(0);
  });
});
