const actions = { click: "点击", fill: "输入", type: "输入", select: "选择", scroll: "滚动", wait: "等待", navigate: "打开网页", done: "完成，待核验", DONE: "完成，待核验", stop: "停止", blocked: "操作受阻" };

/** 日常阅读用动作摘要；完整协议仅放在按需展开的技术详情中。 */
export function BrowserActionSummary({ action }) {
  const value = action && typeof action === "object" ? action : {};
  const kind = value.kind ?? value.operation;
  const label = value.label ?? value.target?.label ?? value.url;
  const input = value.text ?? value.value;
  return <div className="min-w-0 space-y-1 break-words">
    <p>{actions[kind] ?? "网页操作"}{label ? ` · ${label}` : ""}</p>
    {typeof input === "string" && input && <p className="line-clamp-2 text-muted-foreground">输入内容：{input.slice(0, 160)}{input.length > 160 ? "…" : ""}</p>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">技术详情</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(action, null, 2)}</pre></details>
  </div>;
}
