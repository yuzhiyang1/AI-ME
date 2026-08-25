export {};

declare global {
  interface Window {
    /** Electron 预加载脚本提供的最小桌面运行上下文。 */
    aiMeDesktop?: {
      mode: "desktop";
      platform: string;
      apiBaseUrl: string;
      versions: {
        chrome?: string;
        electron?: string;
      };
    };
  }
}
