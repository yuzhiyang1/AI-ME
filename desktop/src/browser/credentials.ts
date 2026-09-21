import { requiredString, webUrl } from './types.js';

/** 本次会话联调凭据仅驻留主进程内存，不写磁盘、日志、模型或后端账本。 */
export class BrowserCredentials {
  private readonly entries = new Map<string, { origin: string; value: string }>();

  save(sessionId: string, input: Record<string, unknown>): { name: string; origin: string } {
    const name = requiredString(input.name, '凭据名称', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('凭据名称只允许字母、数字、下划线和短横线');
    const origin = new URL(webUrl(input.origin)).origin;
    const value = requiredString(input.value, '凭据内容', 10000);
    this.entries.set(`${sessionId}:${name}`, { origin, value });
    return { name, origin };
  }

  resolve(sessionId: string, name: string, origin: string): string {
    const entry = this.entries.get(`${sessionId}:${name}`);
    if (!entry || entry.origin !== origin) throw new Error('凭据不存在或不属于当前站点，请在浏览器面板配置');
    return entry.value;
  }

  /** 输出即使意外包含页面回显的凭据，也不得流入聊天和持久工具日志。 */
  redact(sessionId: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.redact(sessionId, item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(sessionId, item)]));
    if (typeof value !== 'string') return value;
    let text = value;
    for (const [key, entry] of this.entries) {
      if (key.startsWith(`${sessionId}:`)) text = text.split(entry.value).join('[已隐藏凭据]');
    }
    return text;
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.entries.clear();
    else for (const key of this.entries.keys()) if (key.startsWith(`${sessionId}:`)) this.entries.delete(key);
  }
}
