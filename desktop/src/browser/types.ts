import type { Rectangle } from "electron";

export type BrowserOperation = "navigate" | "back" | "forward" | "reload" | "stop" | "close" | "state" | "observe" | "act";
export type BrowserActionKind = "click" | "fill" | "select" | "scroll" | "wait";

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  hasPage: boolean;
}

export interface BrowserAction {
  /** 仅在所属 snapshotId 内有效，不是 CSS selector。 */
  id: string;
  kind: BrowserActionKind;
  label: string;
  node?: number;
  /** select 的选项值、scroll 的方向，均由观察结果确定。 */
  value?: string;
  role?: string;
}

export interface BrowserSnapshot {
  snapshotId: string;
  url: string;
  title: string;
  text: string;
  actions: BrowserAction[];
}

export interface BrowserViewport {
  sessionId: string;
  /** 相对窗口内容区的 DIP 坐标；null 撤销该会话的可见资格。 */
  rect: Rectangle | null;
}

export interface BrowserActResult {
  ok: true;
  /** 导航可能让 CDP 回包丢失；uncertain 只允许重新观察，绝不能自动重试动作。 */
  outcome: "completed" | "uncertain";
  /** 动作执行后必须重新 observe；不会自动重试有副作用的动作。 */
  snapshotId: string;
  actionId: string;
  state: BrowserState;
}

export const EMPTY_STATE: BrowserState = {
  url: "", title: "", canGoBack: false, canGoForward: false, loading: false, hasPage: false,
};

export const MAX_PAGES = 8;
export const SNAPSHOT_TTL_MS = 60_000;

/** 所有入口复用同一协议校验，不补全协议，也不交给外部程序处理。 */
export function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error("浏览器 URL 无效，请提供完整的 http/https 地址");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("浏览器 URL 无效"); }
  if (!/^https?:\/\//i.test(value) || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("浏览器只允许无内嵌凭据的 http/https 地址");
  }
  return url.href;
}

export function isWebUrl(value: unknown): boolean {
  try { webUrl(value); return true; } catch { return false; }
}

/** 拒绝未知参数，避免模型把 selector、脚本或任意操作混入动作请求。 */
export function commandArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("浏览器参数必须是对象");
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("浏览器参数包含未允许的字段");
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 无效`);
  return value;
}

/** 不允许 native view 越过窗口内容区；零面积视为隐藏。 */
export function viewportRect(rect: Rectangle, width: number, height: number): Rectangle | null {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error("浏览器视口坐标无效");
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(width, Math.round(rect.x + rect.width));
  const bottom = Math.min(height, Math.round(rect.y + rect.height));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
