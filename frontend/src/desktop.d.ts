export {};

declare global {
  interface Window {
    /** Electron 预加载脚本提供的最小桌面运行上下文。 */
    aiMeDesktop?: {
      mode: "desktop";
      platform: string;
      apiBaseUrl: string;
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
