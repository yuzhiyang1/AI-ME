import { isWebUrl, webUrl } from "./types.js";

export interface BrowserHostOptions {
  /** 工作台与后端来源；其端口对所有域名一律封锁，以防 DNS 映射回环地址。 */
  blockedOrigins?: string[];
}

function port(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/** 页面请求与程序导航共享策略；不允许通过回环别名访问应用控制面。 */
export class BrowserNetworkPolicy {
  private readonly origins: Set<string>;
  private readonly blockedPorts: Set<string>;

  constructor(blockedOrigins: string[] = []) {
    const blocked = blockedOrigins.map((origin) => new URL(webUrl(origin)));
    this.origins = new Set(blocked.map((url) => url.origin));
    this.blockedPorts = new Set(blocked.map(port));
  }

  allows(input: string, navigation = false): boolean {
    let url: URL;
    try { url = new URL(input); } catch { return false; }
    // WebSocket 同样不能连接应用本地端口；data/blob 仅可作为页面内部资源。
    if (navigation && !isWebUrl(input)) return false;
    if (!navigation && ["data:", "blob:"].includes(url.protocol)) {
      if (url.protocol === "data:") return true;
      return this.allows(url.pathname, true);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) return false;
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return !this.origins.has(url.origin) && !this.blockedPorts.has(port(url));
  }

  navigation(input: unknown): string {
    const url = webUrl(input);
    if (!this.allows(url, true)) throw new Error("内置网页禁止访问应用工作台或后端来源");
    return url;
  }
}
