import type { SessionContextUsage, SessionTokenUsage } from "./api";
import { SessionContextRing } from "./SessionContextRing";

type SessionUsageBarProps = {
  usage: SessionTokenUsage | null;
  fallbackContextWindow: number | null;
};

const tokenFormatter = new Intl.NumberFormat("zh-CN");

/** 区分累计计费用量与最近一个模型步骤的近似上下文占用。 */
export function SessionUsageBar({ usage, fallbackContextWindow }: SessionUsageBarProps) {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
  const contextTokens = usage?.currentContextTokens ?? null;
  const contextWindow = usage?.contextWindow ?? fallbackContextWindow;
  const percentage = contextPercentage(contextTokens, contextWindow);
  const contextUsage: SessionContextUsage = {
    currentContextTokens: contextTokens,
    contextWindow,
    percentage,
    partial: (usage?.unreportedSteps ?? 0) > 0 || usage?.untrackedHistory === true,
  };
  const progressText =
    contextTokens !== null && contextWindow !== null
      ? `${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} Token`
      : "等待模型返回上下文用量";
  const hasPartialUsage =
    (usage?.unreportedSteps ?? 0) > 0 || usage?.untrackedHistory === true;

  return (
    <section
      className={`session-usage-bar${usage === null ? " is-loading" : ""}`}
      aria-label="本次会话 Token 用量"
      title="上下文为最近模型步骤的输入加输出占模型窗口的近似进度；输入、输出和合计为本会话累计值"
    >
      <div className="context-usage">
        <SessionContextRing usage={contextUsage} label="上下文占用" valueText={progressText} />
        <div className="context-usage-copy">
          <span>上下文{usage?.windowNumber ? ` · 窗口 ${usage.windowNumber}` : ""}</span>
          <strong>{percentage === null ? "等待首次模型用量"
            : `${usage?.contextEstimated ? "估算" : "已使用"} ${percentage}%`}</strong>
        </div>
      </div>
      <div className="token-totals" aria-label="累计 Token">
        <span>输入 {formatTokens(inputTokens)}</span>
        <span>输出 {formatTokens(outputTokens)}</span>
        <span>合计 {formatTokens(totalTokens)}</span>
        {hasPartialUsage ? <em>部分调用未返回用量</em> : null}
      </div>
    </section>
  );
}

function formatTokens(value: number) {
  return tokenFormatter.format(value);
}

function contextPercentage(tokens: number | null, window: number | null) {
  if (tokens === null || window === null || window <= 0) return null;
  return Math.min(100, Math.round((tokens / window) * 100));
}
