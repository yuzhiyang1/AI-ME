import type { CSSProperties } from "react";

import type { SessionContextUsage } from "./api";

type SessionContextRingProps = {
  usage?: SessionContextUsage | null;
  label: string;
  size?: number;
  valueText?: string;
};

/** 在输入区和侧栏复用同一套上下文阈值、可访问语义与圆环绘制。 */
export function SessionContextRing({
  usage,
  label,
  size = 17,
  valueText,
}: SessionContextRingProps) {
  const percentage = usage?.percentage ?? null;
  const style = { "--context-ring-size": `${size}px` } as CSSProperties;
  return (
    <span
      className={`context-ring ${contextTone(percentage)}`}
      style={style}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage ?? undefined}
      aria-valuetext={valueText ?? (percentage === null ? "等待模型返回上下文用量" : `已使用 ${percentage}%`)}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-ring-track" cx="10" cy="10" r="7.5" />
        <circle
          className="context-ring-value"
          cx="10"
          cy="10"
          r="7.5"
          pathLength="100"
          style={{ strokeDashoffset: 100 - (percentage ?? 0) }}
        />
      </svg>
    </span>
  );
}

export function contextTone(percentage: number | null) {
  if (percentage === null) return "unknown";
  if (percentage >= 85) return "danger";
  if (percentage >= 70) return "warning";
  return "healthy";
}
