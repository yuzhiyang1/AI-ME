import { createContext, type ComponentType } from "react";

/** 宿主可替换浏览器内容；缺省仍使用 ZCode 的原生浏览器生命周期。 */
export interface HostBrowserPaneProps {
  visible: boolean;
  initialUrl?: string;
  navigationRequest?: { id: string; url: string } | null;
  onNavigationHandled?: (id: string) => void;
  onClose: () => void;
}

export const HostBrowserPaneContext = createContext<ComponentType<HostBrowserPaneProps> | null>(null);
