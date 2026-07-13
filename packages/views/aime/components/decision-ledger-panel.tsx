"use client";

import {
  AlertCircle,
  BookOpenCheck,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import type {
  AIMeDecision,
  ListAIMeDecisionsResponse,
} from "@multica/core/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../../navigation";

interface DecisionLedgerPanelProps {
  data?: ListAIMeDecisionsResponse;
  isLoading: boolean;
  isRefetching: boolean;
  error: string;
  onRetry: () => void;
  approvalPath: (id: string) => string;
}

export function DecisionLedgerPanel({
  data,
  isLoading,
  isRefetching,
  error,
  onRetry,
  approvalPath,
}: DecisionLedgerPanelProps) {
  const summary = data?.summary;
  const decisions = data?.decisions ?? [];

  return (
    <section className="shrink-0 overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--aime-border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--aime-surface-subtle)]">
            <BookOpenCheck className="size-4 text-[var(--aime-brand-600)]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">决策账本</h2>
            <p className="mt-0.5 text-xs leading-5 text-[var(--aime-text-tertiary)]">
              核对今日成本、预算余量和最近决策质量。
            </p>
          </div>
        </div>
        {!isLoading && !error && (
          <p className="text-xs text-[var(--aime-text-tertiary)]">
            今日运行 <span className="font-mono tabular-nums text-[var(--aime-text)]">{summary?.today_runs ?? 0}</span>
            <span className="mx-1.5">·</span>
            成功 {summary?.succeeded ?? 0} / 失败 {summary?.failed ?? 0}
          </p>
        )}
      </div>

      <div className="p-4">
        {error ? (
          <Alert className="border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)]">
            <AlertCircle className="size-4 text-[var(--aime-warning)]" />
            <AlertTitle>决策账本暂不可用</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>加载成本与质量记录失败：{error}。现有审批不受影响。</span>
              <button
                type="button"
                onClick={onRetry}
                disabled={isRefetching}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--aime-border-strong)] bg-[var(--aime-surface)] px-3 text-xs font-medium text-[var(--aime-text-secondary)] hover:bg-[var(--aime-surface-muted)] disabled:opacity-60"
              >
                <RefreshCw className={cn("size-3.5", isRefetching && "animate-spin")} />
                {isRefetching ? "重试中" : "重新加载"}
              </button>
            </AlertDescription>
          </Alert>
        ) : isLoading ? (
          <DecisionLedgerSkeleton />
        ) : (
          <>
            <div className="grid rounded-xl bg-[var(--aime-surface-subtle)] md:grid-cols-3 md:divide-x md:divide-[var(--aime-border)]">
              <LedgerMetric
                label="今日成本"
                value={formatMicrousd(summary?.cost_microusd ?? 0)}
                hint={`${formatInteger(totalTokens(summary))} Token`}
              />
              <LedgerMetric
                label="剩余预算"
                value={summary?.budget_configured === true
                  ? formatMicrousd(summary.remaining_budget_microusd)
                  : "未配置"}
                hint={summary?.budget_configured === true
                  ? `${budgetStatusLabel(summary.budget_status)} · 日预算 ${formatMicrousd(summary.daily_budget_microusd)}`
                  : "今日成本暂不设上限"}
                tone={budgetTone(summary?.budget_status)}
              />
              <LedgerMetric
                label="平均质量"
                value={(summary?.reviewed ?? 0) > 0 ? `${summary?.avg_score.toFixed(1)}/5` : "待复盘"}
                hint={`已复盘 ${summary?.reviewed ?? 0} · 通过 ${summary?.accepted ?? 0}`}
                tone={(summary?.wrong ?? 0) > 0 ? "danger" : "success"}
              />
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold text-[var(--aime-text-secondary)]">最近决策</h3>
                <span className="text-[11px] text-[var(--aime-text-tertiary)]">
                  显示 {decisions.length} / 共 {data?.total ?? 0}
                </span>
              </div>
              {decisions.length === 0 ? (
                <div className="flex min-h-28 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--aime-border)] px-4 py-5 text-center">
                  <CheckCircle2 className="size-5 text-[var(--aime-success)]" />
                  <p className="mt-2 text-sm font-medium">暂无决策记录</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
                    AI-Me 完成审批决策后，会在这里留下模型、成本和质量证据。
                  </p>
                </div>
              ) : (
                <DecisionRows decisions={decisions} approvalPath={approvalPath} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function DecisionRows({
  decisions,
  approvalPath,
}: {
  decisions: AIMeDecision[];
  approvalPath: (id: string) => string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--aime-border)]">
      <div className="hidden grid-cols-[minmax(0,1.55fr)_minmax(132px,0.7fr)_minmax(132px,0.7fr)_minmax(160px,0.8fr)] gap-3 bg-[var(--aime-surface-subtle)] px-3 py-2 text-[11px] font-medium text-[var(--aime-text-tertiary)] xl:grid">
        <span>决策</span>
        <span>模型与步骤</span>
        <span>Token 与成本</span>
        <span>质量与审批</span>
      </div>
      <div className="divide-y divide-[var(--aime-border)]">
        {decisions.map((decision) => (
          <article
            key={decision.approval_id}
            className="grid min-w-0 gap-3 px-3 py-3 hover:bg-[var(--aime-surface-subtle)] xl:grid-cols-[minmax(0,1.55fr)_minmax(132px,0.7fr)_minmax(132px,0.7fr)_minmax(160px,0.8fr)]"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <ExecutionBadge status={decision.execution_status} />
                <RiskBadge risk={decision.risk_level} />
                <span className="text-[11px] text-[var(--aime-text-tertiary)]">
                  {sourceLabel(decision.source_type)} · {formatDecisionTime(decision.completed_at ?? decision.created_at)}
                </span>
              </div>
              <p className="mt-1.5 truncate text-sm font-semibold" title={decision.title}>
                {decision.title}
              </p>
            </div>

            <div className="min-w-0 text-xs leading-5">
              <p className="truncate font-medium" title={modelLabel(decision)}>{modelLabel(decision)}</p>
              <p className="text-[var(--aime-text-tertiary)]">
                步骤 {decision.step_count}/{decision.max_steps || "-"}
              </p>
            </div>

            <div className="min-w-0 text-xs leading-5">
              <p className="font-mono tabular-nums">
                {formatInteger(decision.input_tokens + decision.output_tokens)} Token
              </p>
              <p className="text-[var(--aime-text-tertiary)]">
                缓存 {formatInteger(decision.cache_read_tokens)} · {formatMicrousd(decision.cost_microusd)}
              </p>
            </div>

            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0 text-xs leading-5">
                <p className="font-medium">
                  {decision.reviewed_at ? `${decision.quality_score.toFixed(1)}/5` : "待复盘"}
                </p>
                <p className="truncate text-[var(--aime-text-tertiary)]" title={decision.quality_note}>
                  {qualityOutcomeLabel(decision.quality_outcome)}
                </p>
              </div>
              <AppLink
                href={approvalPath(decision.approval_id)}
                aria-label={`查看审批 ${decision.title}`}
                className="inline-flex h-8 shrink-0 items-center rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface)] px-2.5 text-xs font-medium text-[var(--aime-brand-600)] hover:bg-[var(--aime-brand-50)]"
              >
                审批
              </AppLink>
            </div>

            {decision.last_error && (
              <p
                className="break-words rounded-lg bg-[var(--aime-danger-bg)] px-2.5 py-2 text-xs leading-5 text-[var(--aime-danger)] xl:col-span-4"
                title={decision.last_error}
              >
                失败原因：{decision.last_error}
              </p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function LedgerMetric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-[11px] font-medium text-[var(--aime-text-tertiary)]">{label}</p>
      <p className={cn(
        "mt-1 font-mono text-xl font-semibold tabular-nums",
        tone === "success" && "text-[var(--aime-success)]",
        tone === "warning" && "text-[var(--aime-warning)]",
        tone === "danger" && "text-[var(--aime-danger)]",
      )}>
        {value}
      </p>
      <p className="mt-1 truncate text-xs text-[var(--aime-text-tertiary)]" title={hint}>{hint}</p>
    </div>
  );
}

function DecisionLedgerSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
      </div>
    </div>
  );
}

function ExecutionBadge({ status }: { status: AIMeDecision["execution_status"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[11px]",
        status === "succeeded" && "border-[var(--aime-success-bg)] bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
        status === "failed" && "border-[var(--aime-danger-bg)] bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        status === "running" && "border-[var(--aime-info-bg)] bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
      )}
    >
      {executionStatusLabel(status)}
    </Badge>
  );
}

function RiskBadge({ risk }: { risk: AIMeDecision["risk_level"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[11px]",
        risk === "high" && "border-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        risk === "medium" && "border-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        risk === "low" && "border-[var(--aime-border)] text-[var(--aime-text-tertiary)]",
      )}
    >
      {risk === "high" ? "高风险" : risk === "medium" ? "中风险" : risk === "low" ? "低风险" : "风险未知"}
    </Badge>
  );
}

function totalTokens(summary: ListAIMeDecisionsResponse["summary"] | undefined) {
  if (!summary) return 0;
  return summary.input_tokens + summary.output_tokens + summary.cache_read_tokens;
}

function formatMicrousd(value: number) {
  const usd = Math.max(0, value) / 1_000_000;
  const digits = usd > 0 && usd < 0.01 ? 4 : 2;
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatInteger(value: number) {
  return Math.max(0, value).toLocaleString("zh-CN");
}

function formatDecisionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function modelLabel(decision: AIMeDecision) {
  if (decision.provider && decision.model) return `${decision.provider} / ${decision.model}`;
  return decision.model || decision.provider || "未记录模型";
}

function budgetTone(status: ListAIMeDecisionsResponse["summary"]["budget_status"] | undefined) {
  if (status === "exceeded") return "danger" as const;
  if (status === "warning") return "warning" as const;
  if (status === "ok") return "success" as const;
  return "neutral" as const;
}

function budgetStatusLabel(status: ListAIMeDecisionsResponse["summary"]["budget_status"]) {
  switch (status) {
    case "ok":
      return "预算正常";
    case "warning":
      return "接近上限";
    case "exceeded":
      return "已超预算";
    case "unconfigured":
      return "未配置";
    default:
      return "预算状态未知";
  }
}

function executionStatusLabel(status: AIMeDecision["execution_status"]) {
  switch (status) {
    case "not_started":
      return "未执行";
    case "running":
      return "执行中";
    case "succeeded":
      return "执行成功";
    case "failed":
      return "执行失败";
    case "skipped":
      return "已跳过";
    default:
      return "状态未知";
  }
}

function qualityOutcomeLabel(outcome: AIMeDecision["quality_outcome"]) {
  switch (outcome) {
    case "accepted":
      return "质量通过";
    case "needs_retry":
      return "需要重试";
    case "wrong":
      return "判断错误";
    default:
      return "尚未给出结论";
  }
}

function sourceLabel(source: AIMeDecision["source_type"]) {
  switch (source) {
    case "feishu":
      return "飞书";
    case "email":
      return "邮件";
    case "github":
      return "GitHub";
    case "issue":
      return "工作项";
    case "inbox":
      return "收件箱";
    case "manual":
      return "手动";
    default:
      return "其他来源";
  }
}
