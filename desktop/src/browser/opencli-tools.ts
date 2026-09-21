// 工具语义参考 Maka browser-tools.ts；定位、输入、点击与观察直接复用 OpenCLI。
import type { IPage } from '@jackwener/opencli/types';
import { htmlToMarkdown } from '@jackwener/opencli/utils';
import { requiredString } from './types.js';

/** Maka 显示 [12]，OpenCLI 实际需要 12；CSS 选择器保持原样。 */
export function normalizeRef(value: unknown): string {
  const ref = requiredString(value, 'ref', 2000);
  return /^\s*\[(\d+)\]\s*$/.exec(ref)?.[1] ?? ref;
}

export async function executeOpenCliTool(
  page: IPage, name: string, args: Record<string, unknown>,
  guard: () => void, resolveCredential: (name: string) => string,
): Promise<Record<string, unknown>> {
  guard();
  if (name === 'snapshot') {
    const snapshot = await page.snapshot({ interactive: true, maxTextLength: 16000 });
    return { snapshot: (typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)).slice(0, 24000) };
  }
  if (name === 'click') return { ...await page.click(normalizeRef(args.ref)) };
  if (name === 'type') {
    const credential = args.credential === undefined ? undefined : requiredString(args.credential, 'credential', 64);
    if ((credential === undefined) === (args.text === undefined)) throw new Error('text 和 credential 必须二选一');
    const text = credential ? resolveCredential(credential) : args.text;
    if (typeof text !== 'string' || text.length > 10000) throw new Error('输入文字过长或无效');
    if (credential) {
      // 密码仅注入顶层文档的唯一输入框；不让跨站 iframe 或模糊快照 ref 接收秘密。
      const selector = requiredString(args.ref, 'ref', 2000);
      const eligible = await page.evaluate((query: string) => {
        const elements = document.querySelectorAll(query);
        const element = elements[0];
        return elements.length === 1 && element instanceof HTMLInputElement
          && ['text', 'password', 'email', 'tel'].includes(element.type);
      }, selector);
      guard();
      if (!eligible) throw new Error('凭据输入需要顶层页面唯一的 CSS 输入框选择器');
    }
    const result = await page.fillText(normalizeRef(args.ref), text);
    guard();
    if (args.submit === true && result.verified) await page.pressKey('Enter');
    // 不复制 actual/expected 回显，避免密码和输入内容进入工具账本。
    return { filled: result.filled, verified: result.verified, matchLevel: result.match_level };
  }
  if (name === 'wait') {
    if (['text', 'selector', 'time'].filter(key => args[key] !== undefined).length !== 1) throw new Error('text、selector、time 必须三选一');
    const seconds = args.time ?? args.timeout ?? 10;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 20) throw new Error('等待时间必须在 0 到 20 秒之间');
    await page.wait(args.time !== undefined ? { time: seconds } : {
      ...(args.text !== undefined ? { text: requiredString(args.text, 'text', 4000) } : { selector: requiredString(args.selector, 'selector', 2000) }),
      timeout: seconds,
    });
    return { conditionMet: true };
  }
  if (name === 'extract') {
    const selector = args.selector === undefined ? 'body' : requiredString(args.selector, 'selector', 2000);
    const start = args.start ?? 0;
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) throw new Error('start 必须是非负整数');
    // 只执行固定脚本，模型不能提供 JavaScript；读取前移除表单值和脚本。
    const html = await page.evaluate((query: string) => {
      const original = document.querySelector(query);
      if (!original) throw new Error('未找到正文区域');
      const clone = original.cloneNode(true) as Element;
      for (const item of clone.querySelectorAll('input,textarea,script,style')) item.remove();
      if (clone.matches('input,textarea,script,style')) return '';
      return clone.outerHTML.slice(0, 2_000_000);
    }, selector);
    const markdown = htmlToMarkdown(html);
    return { text: markdown.slice(start, start + 16000), nextStart: start + 16000 < markdown.length ? start + 16000 : null };
  }
  throw new Error('不支持的浏览器工具');
}
