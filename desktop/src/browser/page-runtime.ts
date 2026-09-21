import type { BrowserAction, BrowserSnapshot } from "./types.js";

/**
 * 整个函数在 CDP 创建的隔离世界运行，无 preload、IPC、Node 或模型脚本。
 * 保留原始节点引用，校验和副作用处于同一个同步调用中，避免跨导航重新选中节点。
 * 不跨 iframe/Shadow DOM 自动探索；无法可靠观察的控件不生成动作。
 */
export function createPageRuntime() {
  type Entry = { action: BrowserAction; element?: HTMLElement; geometry?: string };
  type Saved = {
    id: string; url: string; created: number; document: Document;
    fingerprint: string; entries: Map<string, Entry>; changed: boolean;
  };
  let saved: Saved | undefined;
  const observer = new MutationObserver(() => { if (saved) saved.changed = true; });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  // 事件能发现用户输入后又还原的情况；属性未变化的程序赋值由指纹补充检查。
  const invalidate = () => { if (saved) saved.changed = true; };
  document.addEventListener("input", invalidate, true);
  document.addEventListener("change", invalidate, true);
  window.addEventListener("pagehide", invalidate, true);
  window.addEventListener("hashchange", invalidate, true);
  window.addEventListener("popstate", invalidate, true);

  function password(element: Element): boolean {
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    return element.matches('input[type="password"]') || autocomplete.some((token) => token === "current-password" || token === "new-password");
  }

  function disabled(element: HTMLElement): boolean {
    return element.matches(":disabled") || !!element.closest('[inert], [aria-disabled="true"]');
  }

  function visible(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 || current.hasAttribute("hidden")) return false;
    }
    return true;
  }

  function targetPoint(element: HTMLElement): { x: number; y: number } {
    if (!element.isConnected || element.ownerDocument !== document || !visible(element) || disabled(element) || password(element)) {
      throw new Error("目标已移除、隐藏、禁用或属于密码字段，请重新观察");
    }
    const rect = element.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === element || element.contains(hit))) throw new Error("目标被其他元素遮挡，请重新观察");
    return { x, y };
  }

  function geometry(element: HTMLElement): string {
    const rect = element.getBoundingClientRect();
    return JSON.stringify([rect.x, rect.y, rect.width, rect.height]);
  }

  function fingerprint(): string {
    // 完整文档和全部表单状态仅在隔离世界内比较，密码值绝不返回主进程或模型。
    const html = document.documentElement.outerHTML;
    if (html.length > 2_000_000) throw new Error("页面过大，无法安全生成快照");
    const fields = Array.from(document.querySelectorAll("input,textarea,select"), (element) => {
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return [field.value, element instanceof HTMLInputElement ? element.checked : null,
        element instanceof HTMLSelectElement ? Array.from(element.options, (option) => option.selected) : null];
    });
    return JSON.stringify([location.href, html, fields, scrollX, scrollY, innerWidth, innerHeight]);
  }

  function label(element: HTMLElement): string {
    const control = element as HTMLInputElement;
    const labels = control.labels ? Array.from(control.labels, (item) => item.innerText).join(" ") : "";
    return (element.getAttribute("aria-label") || labels || element.innerText || element.getAttribute("placeholder") || element.getAttribute("title") || element.tagName.toLowerCase()).replace(/\s+/g, " ").slice(0, 180);
  }

  function observe(snapshotId: string): BrowserSnapshot {
    saved = undefined;
    observer.takeRecords();
    if (!/^https?:$/.test(location.protocol)) throw new Error("当前页面协议不允许观察");
    const elements = document.querySelectorAll("*");
    if (elements.length > 10_000) throw new Error("页面节点过多，无法安全生成快照");
    const entries = new Map<string, Entry>();
    const lines: string[] = [];
    let node = 0;
    const add = (action: Omit<BrowserAction, "id">, element?: HTMLElement) => {
      if (entries.size >= 400) return;
      const id = String(entries.size + 1);
      entries.set(id, { action: { ...action, id }, element, geometry: element ? geometry(element) : undefined });
    };

    // 单次同步遍历同时提取可见文字和编号控件；不向 DOM 写入标记。
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element) || password(element) || element.closest("script,style,noscript,iframe")) continue;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
          lines.push(child.textContent.trim().replace(/\s+/g, " "));
        }
      }
      if (disabled(element)) continue;
      try { targetPoint(element); } catch { continue; }
      const role = element.getAttribute("role") || element.tagName.toLowerCase();
      const name = label(element);
      const currentNode = ++node;
      const base = { node: currentNode, label: name, role };
      if ((element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number"].includes(element.type) && !element.readOnly)
        || (element instanceof HTMLTextAreaElement && !element.readOnly)) {
        add({ ...base, kind: "fill", value: element.value.slice(0, 2000) }, element);
        lines.push(`[${currentNode}] ${name}`);
      } else if (element instanceof HTMLSelectElement && !element.multiple) {
        for (const option of element.options) {
          if (!option.disabled && !option.closest("optgroup:disabled")) {
            add({ ...base, kind: "select", label: `${name}: ${option.text}`, value: option.value }, element);
          }
        }
        lines.push(`[${currentNode}] ${name}`);
      } else if (element.matches('a[href],button,input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],[role="button"],[role="link"],[role="checkbox"],[role="tab"]')) {
        // 点击密码标签可能间接聚焦密码输入；这类代理控件也不提供。
        if (element instanceof HTMLAnchorElement && !/^https?:$/.test(new URL(element.href).protocol)) continue;
        add({ ...base, kind: "click" }, element);
        lines.push(`[${currentNode}] ${name}`);
      }
    }
    const root = document.scrollingElement;
    if (root && scrollY > 0) add({ kind: "scroll", label: "向上滚动一屏", value: "up" });
    if (root && scrollY + innerHeight < root.scrollHeight) add({ kind: "scroll", label: "向下滚动一屏", value: "down" });
    add({ kind: "wait", label: "等待页面更新（500 毫秒）", value: "500" });
    const digest = fingerprint();
    saved = { id: snapshotId, url: location.href, created: Date.now(), document, fingerprint: digest, entries, changed: false };
    return { snapshotId, url: location.href, title: document.title, text: lines.join("\n").slice(0, 24_000), actions: Array.from(entries.values(), (entry) => entry.action) };
  }

  function act(snapshotId: string, actionId: string, text?: string): { ok: true; waitMs?: number } {
    const snapshot = saved;
    // 单次消费，包括校验失败；失败后只能重新 observe，不能拿旧审批继续尝试。
    saved = undefined;
    if (!snapshot || snapshot.id !== snapshotId || snapshot.document !== document || snapshot.url !== location.href
      || Date.now() - snapshot.created > 60_000 || snapshot.changed || observer.takeRecords().length > 0
      || snapshot.fingerprint !== fingerprint()) throw new Error("快照已过期或页面/表单已变化，请重新观察");
    const entry = snapshot.entries.get(actionId);
    if (!entry) throw new Error("动作不属于当前观察结果");
    const { action, element } = entry;
    if (action.kind !== "fill" && text !== undefined) throw new Error("该动作不接受文本参数");
    if (element) {
      targetPoint(element);
      if (geometry(element) !== entry.geometry) throw new Error("目标位置已变化，请重新观察");
    }

    // 校验后立即调用隔离世界中的原生 DOM 方法，不使用页面定义的函数/selector。
    if (action.kind === "click" && element) {
      HTMLElement.prototype.click.call(element);
    } else if (action.kind === "fill" && element) {
      if (typeof text !== "string" || text.length > 20_000) throw new Error("填写文本无效或过长");
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      if (input.readOnly || password(input) || (input.maxLength >= 0 && text.length > input.maxLength)) throw new Error("字段不允许填写该文本");
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // input 监听器可能已导航/替换目标，不能向新页面继续派发后续事件。
      if (input.isConnected && input.ownerDocument === document && location.href === snapshot.url) input.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (action.kind === "select" && element instanceof HTMLSelectElement) {
      const option = Array.from(element.options).find((item) => item.value === action.value);
      if (!option || option.disabled || option.closest("optgroup:disabled")) throw new Error("选项已失效");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, action.value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      if (element.isConnected && element.ownerDocument === document && location.href === snapshot.url) element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (action.kind === "scroll") {
      window.scrollBy({ top: Math.max(100, innerHeight * 0.8) * (action.value === "up" ? -1 : 1), behavior: "instant" });
    } else if (action.kind === "wait") {
      return { ok: true, waitMs: 500 };
    } else throw new Error("不支持的观察动作");
    return { ok: true };
  }

  function revoke(): void {
    saved = undefined;
    observer.disconnect();
    document.removeEventListener("input", invalidate, true);
    document.removeEventListener("change", invalidate, true);
    window.removeEventListener("pagehide", invalidate, true);
    window.removeEventListener("hashchange", invalidate, true);
    window.removeEventListener("popstate", invalidate, true);
  }
  return { observe, act, revoke };
}
