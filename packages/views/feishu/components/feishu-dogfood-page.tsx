"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  DollarSign,
  ExternalLink,
  Loader2,
  MessagesSquare,
  RefreshCcw,
  Send,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { feishuDogfoodPanelOptions } from "@multica/core/aime";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import type {
  AIMeCostControl,
  AIMeModelRouting,
  AIMeOnboardingStep,
  AIMeQualitySummary,
  FeishuDelivery,
  FeishuDeliverySummary,
  FeishuDogfoodChecklistItem,
  FeishuIntegrationStatus,
  FeishuMessageLog,
  FeishuReliabilitySummary,
  FeishuWebhookEvent,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { AppLink } from "../../navigation";

const PANEL_PARAMS = { limit: 40 };

export function FeishuDogfoodPage() {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const panelQuery = useQuery(feishuDogfoodPanelOptions(wsId, PANEL_PARAMS));
  const data = panelQuery.data;
  const summary = data?.summary;
  const progress = summary
    ? percentage(summary.dogfood_completed, summary.dogfood_target)
    : 0;
  const connectionReady = data?.status.incoming_configured && data.status.outgoing_configured;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)] text-[var(--aime-text)]">
      <PageHeader className="h-16 justify-between border-b border-[var(--aime-border)] bg-[var(--aime-surface)] px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MessagesSquare className="size-4 text-[var(--aime-brand-600)]" />
            <h1 className="truncate text-base font-semibold tracking-normal">飞书狗粮测试</h1>
            <Badge variant="outline" className="border-[var(--aime-border)] text-[var(--aime-text-tertiary)]">
              真实入口
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
            接收同事发来的消息，生成回复草稿，审批后发送，并记录质量和成本。
          </p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <StatusPill ready={!!connectionReady} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={panelQuery.isFetching}
            onClick={() => void panelQuery.refetch()}
          >
            {panelQuery.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
            刷新
          </Button>
        </div>
      </PageHeader>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        {panelQuery.isError ? (
          <ErrorState
            error={panelQuery.error}
            onRetry={() => void panelQuery.refetch()}
          />
        ) : panelQuery.isLoading || !data || !summary ? (
          <LoadingState />
        ) : (
          <>
            <section className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-5">
              <MetricCard
                label="狗粮进度"
                value={`${summary.dogfood_completed}/${summary.dogfood_target}`}
                hint={`还差 ${summary.dogfood_remaining} 条`}
                tone="brand"
              />
              <MetricCard
                label="已接收"
                value={summary.total_received}
                hint={`今日 ${summary.received_today}`}
                tone="info"
              />
              <MetricCard
                label="待审批"
                value={summary.pending_approval}
                hint={`已建审批 ${summary.approvals_created}`}
                tone="warning"
              />
              <MetricCard
                label="已发送"
                value={summary.sent}
                hint={`失败 ${summary.send_failed}`}
                tone={summary.send_failed > 0 ? "danger" : "success"}
              />
              <MetricCard
                label="质量评分"
                value={summary.quality_reviewed > 0 ? summary.avg_quality_score.toFixed(1) : "未评分"}
                hint={`已复盘 ${summary.quality_reviewed}`}
                tone="success"
              />
            </section>

            <section className="grid shrink-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
              <ProgressPanel
                progress={progress}
                completed={summary.dogfood_completed}
                target={summary.dogfood_target}
                sent={summary.sent}
                failed={summary.send_failed}
                firstReceivedAt={summary.first_received_at}
                lastReceivedAt={summary.last_received_at}
              />
              <CostPanel cost={data.cost} />
            </section>

            <section className="grid shrink-0 gap-4 lg:grid-cols-3">
              <ReliabilityPanel reliability={data.reliability} status={data.status} />
              <DeliveryPanel delivery={data.delivery} />
              <QualityPanel quality={data.quality} />
            </section>

            <ModelRoutePanel route={data.model_route} />

            <section className="grid min-h-[560px] flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <LogsPanel
                logs={data.logs}
                approvalPath={(id) => paths.approvals(id)}
                inboxPath={(id) => paths.inbox({ inboxItemId: id })}
              />
              <aside className="flex min-h-0 flex-col gap-4">
                <ConnectionPanel status={data.status} />
                <ChecklistPanel checklist={data.checklist} />
                <OnboardingPanel steps={data.onboarding.steps} />
                <WebhookEventsPanel events={data.events} />
                <DeliveryListPanel deliveries={data.deliveries} />
              </aside>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function LoadingState() {
  return (
    <>
      <section className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </section>
      <section className="grid flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Skeleton className="min-h-[560px] rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </section>
    </>
  );
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <section className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] px-8 text-center shadow-[var(--aime-shadow-xs)]">
      <AlertCircle className="size-10 text-[var(--aime-danger)]" />
      <h2 className="mt-4 text-sm font-semibold">飞书日志加载失败</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-[var(--aime-text-tertiary)]">
        {error instanceof Error ? error.message : "请检查后端服务和飞书配置后重试。"}
      </p>
      <Button type="button" className="mt-4" onClick={onRetry}>
        <RefreshCcw className="size-4" />
        重试
      </Button>
    </section>
  );
}

function ProgressPanel({
  progress,
  completed,
  target,
  sent,
  failed,
  firstReceivedAt,
  lastReceivedAt,
}: {
  progress: number;
  completed: number;
  target: number;
  sent: number;
  failed: number;
  firstReceivedAt: string | null;
  lastReceivedAt: string | null;
}) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">真实狗粮 20 条</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            只统计真实飞书消息，不把系统内手动测试混进去。
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-2xl font-semibold tabular-nums">{progress}%</p>
          <p className="text-xs text-[var(--aime-text-tertiary)]">完成度</p>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--aime-surface-muted)]">
        <div
          className="h-full rounded-full bg-[var(--aime-brand-500)] transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <InfoCell label="已闭环" value={`${completed}/${target}`} />
        <InfoCell label="成功发送" value={String(sent)} />
        <InfoCell label="发送失败" value={String(failed)} tone={failed > 0 ? "danger" : "neutral"} />
        <InfoCell label="最近消息" value={lastReceivedAt ? formatDateTime(lastReceivedAt) : "暂无"} />
      </div>
      <p className="mt-3 text-xs text-[var(--aime-text-tertiary)]">
        首条消息：{firstReceivedAt ? formatDateTime(firstReceivedAt) : "尚未收到"}
      </p>
    </section>
  );
}

function CostPanel({ cost }: { cost: AIMeCostControl }) {
  const totalTokens =
    cost.worker_input_tokens +
    cost.worker_output_tokens +
    cost.worker_cache_read_tokens +
    cost.worker_cache_write_tokens;
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <DollarSign className="size-4 text-[var(--aime-success)]" />
            成本控制
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            DeepSeek 草稿和员工运行分别计数，超过预算后优先降级低价值草稿。
          </p>
        </div>
        <BudgetBadge status={cost.budget_status} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <InfoCell label="草稿调用" value={String(cost.draft_call_count)} />
        <InfoCell label="草稿成本" value={formatMoney(cost.estimated_draft_cost_cents, cost.currency)} />
        <InfoCell label="日预算" value={formatMoney(cost.daily_budget_cents, cost.currency)} />
        <InfoCell label="剩余额度" value={formatMoney(cost.remaining_budget_cents, cost.currency)} />
      </div>
      <div className="mt-3 rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--aime-text-tertiary)]">员工 task</span>
          <span className="font-mono text-xs font-semibold tabular-nums">{cost.worker_task_count}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--aime-text-tertiary)]">员工 Token</span>
          <span className="font-mono text-xs font-semibold tabular-nums">{formatNumber(totalTokens)}</span>
        </div>
      </div>
    </section>
  );
}

function ReliabilityPanel({
  reliability,
  status,
}: {
  reliability: FeishuReliabilitySummary;
  status: FeishuIntegrationStatus;
}) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">入口可靠性</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            记录 webhook、去重、签名和重放保护状态。
          </p>
        </div>
        <StatusBadge
          status={status.signature_configured ? "succeeded" : "not_started"}
          kind="execution"
        />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <InfoCell label="事件总数" value={String(reliability.webhook_events)} />
        <InfoCell label="今日事件" value={String(reliability.events_today)} />
        <InfoCell label="重复拦截" value={String(reliability.duplicate_events)} />
        <InfoCell label="签名通过" value={String(reliability.signature_verified_events)} />
        <InfoCell label="失败事件" value={String(reliability.failed_events)} tone={reliability.failed_events > 0 ? "danger" : "neutral"} />
        <InfoCell label="最近事件" value={reliability.last_event_at ? formatDateTime(reliability.last_event_at) : "暂无"} />
      </div>
    </section>
  );
}

function DeliveryPanel({ delivery }: { delivery: FeishuDeliverySummary }) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div>
        <h2 className="text-sm font-semibold">发送可靠性</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
          审批通过后的飞书发送会记录尝试次数、失败和死信。
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <InfoCell label="发送记录" value={String(delivery.deliveries)} />
        <InfoCell label="总尝试" value={String(delivery.attempts)} />
        <InfoCell label="成功" value={String(delivery.succeeded)} />
        <InfoCell label="重试中" value={String(delivery.failed)} tone={delivery.failed > 0 ? "danger" : "neutral"} />
        <InfoCell label="死信" value={String(delivery.dead_letter)} tone={delivery.dead_letter > 0 ? "danger" : "neutral"} />
        <InfoCell label="最近发送" value={delivery.last_delivery_at ? formatDateTime(delivery.last_delivery_at) : "暂无"} />
      </div>
    </section>
  );
}

function QualityPanel({ quality }: { quality: AIMeQualitySummary }) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div>
        <h2 className="text-sm font-semibold">决策质量</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
          审批中心评分会汇总到这里，用来复盘 AI-Me 的判断质量。
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <InfoCell label="已复盘" value={String(quality.reviewed)} />
        <InfoCell label="平均分" value={quality.reviewed > 0 ? quality.avg_score.toFixed(1) : "暂无"} />
        <InfoCell label="高质量" value={String(quality.good)} />
        <InfoCell label="低质量" value={String(quality.poor)} tone={quality.poor > 0 ? "danger" : "neutral"} />
        <InfoCell label="需重试" value={String(quality.needs_retry)} tone={quality.needs_retry > 0 ? "danger" : "neutral"} />
        <InfoCell label="最近复盘" value={quality.last_reviewed_at ? formatDateTime(quality.last_reviewed_at) : "暂无"} />
      </div>
    </section>
  );
}

function ModelRoutePanel({ route }: { route: AIMeModelRouting }) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">模型路由与预算</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            {route.worker_policy || "DeepSeek 负责回复草稿，Codex / Claude Code 只承接审批后的员工任务。"}
          </p>
        </div>
        <BudgetBadge status={route.budget_status} />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <InfoCell label="默认大脑" value={`${route.default_provider} / ${route.default_model}`} />
        <InfoCell label="草稿模型" value={`${route.draft_provider} / ${route.draft_model}`} />
        <InfoCell label="每日预算" value={formatMoney(route.daily_budget_cents, "USD")} />
        <InfoCell label="建议动作" value={String(route.recommended_next_actions.length)} />
      </div>
      {route.recommended_next_actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {route.recommended_next_actions.map((action) => (
            <span key={action} className="rounded-lg bg-[var(--aime-surface-muted)] px-2.5 py-1 text-xs text-[var(--aime-text-secondary)]">
              {action}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function LogsPanel({
  logs,
  approvalPath,
  inboxPath,
}: {
  logs: FeishuMessageLog[];
  approvalPath: (id: string) => string;
  inboxPath: (id: string) => string;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--aime-border)] px-4">
        <div>
          <h2 className="text-sm font-semibold">最近飞书消息</h2>
          <p className="mt-0.5 text-xs text-[var(--aime-text-tertiary)]">从接收、审批到发送的真实轨迹。</p>
        </div>
        <span className="font-mono text-xs text-[var(--aime-text-tertiary)]">{logs.length}</span>
      </div>
      {logs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <MessagesSquare className="size-10 text-[var(--aime-text-tertiary)]" />
          <h3 className="mt-4 text-sm font-semibold">还没有真实飞书消息</h3>
          <p className="mt-2 max-w-md text-sm leading-6 text-[var(--aime-text-tertiary)]">
            等飞书事件进入后，这里会显示原始消息、审批状态、发送结果和质量评分。
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {logs.map((log) => (
            <LogRow
              key={`${log.inbox_item_id}-${log.message_id || log.event_id}`}
              log={log}
              approvalPath={approvalPath}
              inboxPath={inboxPath}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LogRow({
  log,
  approvalPath,
  inboxPath,
}: {
  log: FeishuMessageLog;
  approvalPath: (id: string) => string;
  inboxPath: (id: string) => string;
}) {
  const hasApproval = log.approval_id.length > 0;
  return (
    <article className="grid gap-3 border-b border-[var(--aime-border)] px-4 py-4 last:border-b-0 xl:grid-cols-[minmax(0,1.1fr)_180px_180px]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--aime-text-tertiary)]">
            {formatDateTime(log.received_at)}
          </span>
          <RiskBadge risk={log.risk_level || "medium"} />
          {log.gate_reason && (
            <span className="rounded-full bg-[var(--aime-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--aime-text-tertiary)]">
              {gateReasonLabel(log.gate_reason)}
            </span>
          )}
        </div>
        <h3 className="mt-2 line-clamp-1 text-sm font-semibold">
          {log.inbox_title || "飞书消息"}
        </h3>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-[var(--aime-text-secondary)]">
          {log.inbound_text || "消息正文为空。"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <AppLink
            href={inboxPath(log.inbox_item_id)}
            className="inline-flex items-center gap-1 text-[var(--aime-brand-600)] hover:underline"
          >
            查看收件箱
            <ExternalLink className="size-3" />
          </AppLink>
          {hasApproval && (
            <AppLink
              href={approvalPath(log.approval_id)}
              className="inline-flex items-center gap-1 text-[var(--aime-brand-600)] hover:underline"
            >
              查看审批
              <ExternalLink className="size-3" />
            </AppLink>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium text-[var(--aime-text-tertiary)]">审批与执行</p>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge status={log.approval_status || "not_created"} kind="approval" />
          <StatusBadge status={log.execution_status || "not_started"} kind="execution" />
        </div>
        {log.execution_error && (
          <p className="line-clamp-2 text-xs leading-5 text-[var(--aime-danger)]">
            {log.execution_error}
          </p>
        )}
        {log.executed_at && (
          <p className="text-[11px] text-[var(--aime-text-tertiary)]">
            执行：{formatDateTime(log.executed_at)}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium text-[var(--aime-text-tertiary)]">草稿与质量</p>
        <p className="line-clamp-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
          {log.reply_text || "暂无 AI 回复草稿。"}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {log.draft_provider && (
            <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
              {log.draft_provider}
              {log.draft_model ? ` / ${log.draft_model}` : ""}
            </span>
          )}
          {log.quality_score > 0 ? (
            <span className="rounded-md bg-[var(--aime-success-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--aime-success)]">
              评分 {log.quality_score}/5
            </span>
          ) : (
            <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
              未复盘
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function ConnectionPanel({ status }: { status: FeishuIntegrationStatus }) {
  const checks = [
    { label: "接收事件", ok: status.incoming_configured },
    { label: "签名保护", ok: status.signature_configured },
    { label: "发送消息", ok: status.outgoing_configured },
    { label: "工作区匹配", ok: status.workspace_configured && status.workspace_matches },
    { label: "接收人", ok: status.owner_configured },
    { label: "群聊白名单", ok: status.allowed_chat_configured },
  ];
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">飞书连接</h2>
          <p className="mt-1 text-xs text-[var(--aime-text-tertiary)]">
            {status.event_mode === "websocket" ? "WebSocket 长连接" : "Webhook 回调"} · {status.callback_path}
          </p>
        </div>
        <StatusPill ready={status.incoming_configured && status.outgoing_configured} />
      </div>
      <div className="mt-4 space-y-2">
        {checks.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
            <span className="text-xs font-medium">{item.label}</span>
            {item.ok ? (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--aime-success)]">
                <CheckCircle2 className="size-3.5" />
                已就绪
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--aime-warning)]">
                <CircleDashed className="size-3.5" />
                待配置
              </span>
            )}
          </div>
        ))}
      </div>
      {status.warnings.length > 0 && (
        <div className="mt-3 rounded-lg border border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] px-3 py-2">
          {status.warnings.map((warning) => (
            <p key={warning} className="text-xs leading-5 text-[var(--aime-warning)]">
              {warning}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function ChecklistPanel({ checklist }: { checklist: FeishuDogfoodChecklistItem[] }) {
  const completed = checklist.filter((item) => item.completed).length;
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">真实狗粮清单</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            按真实消息闭环验收，不用手动拼测试表。
          </p>
        </div>
        <span className="font-mono text-xs text-[var(--aime-text-tertiary)]">
          {completed}/{checklist.length}
        </span>
      </div>
      <div className="mt-4 space-y-2">
        {checklist.map((item) => (
          <div key={item.key} className="flex gap-2 rounded-lg border border-[var(--aime-border)] px-3 py-2">
            {item.completed ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--aime-success)]" />
            ) : (
              <CircleDashed className="mt-0.5 size-4 shrink-0 text-[var(--aime-text-tertiary)]" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold">{item.title}</p>
              <p className="mt-0.5 text-[11px] leading-5 text-[var(--aime-text-tertiary)]">{item.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function OnboardingPanel({ steps }: { steps: AIMeOnboardingStep[] }) {
  const completed = steps.filter((step) => step.completed).length;
  return (
    <section className="min-h-0 flex-1 rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardCheck className="size-4 text-[var(--aime-brand-600)]" />
            首次使用流程
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            新用户应能在 10 分钟内跑通第一条闭环。
          </p>
        </div>
        <span className="font-mono text-xs text-[var(--aime-text-tertiary)]">
          {completed}/{steps.length}
        </span>
      </div>
      <div className="mt-4 space-y-2">
        {steps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
            后端暂未返回上手步骤。
          </p>
        ) : (
          steps.map((step) => (
            <OnboardingStepRow key={step.key} step={step} />
          ))
        )}
      </div>
    </section>
  );
}

function WebhookEventsPanel({ events }: { events: FeishuWebhookEvent[] }) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">最近入口事件</h2>
        <span className="font-mono text-xs text-[var(--aime-text-tertiary)]">{events.length}</span>
      </div>
      <div className="mt-3 space-y-2">
        {events.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--aime-border)] px-3 py-4 text-xs text-[var(--aime-text-tertiary)]">
            暂无 webhook 事件。
          </p>
        ) : (
          events.slice(0, 6).map((event) => (
            <div key={event.id} className="rounded-lg border border-[var(--aime-border)] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-[var(--aime-text-tertiary)]">
                  {event.event_id || event.message_id || event.event_key}
                </span>
                <StatusBadge status={event.status === "accepted" ? "succeeded" : event.status} kind="execution" />
              </div>
              <p className="mt-1 text-[11px] leading-5 text-[var(--aime-text-tertiary)]">
                签名 {event.signature_verified ? "已通过" : "未验证"} · 重复 {event.duplicate_count}
              </p>
              {event.reason && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-[var(--aime-warning)]">{event.reason}</p>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function DeliveryListPanel({ deliveries }: { deliveries: FeishuDelivery[] }) {
  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">最近发送尝试</h2>
        <span className="font-mono text-xs text-[var(--aime-text-tertiary)]">{deliveries.length}</span>
      </div>
      <div className="mt-3 space-y-2">
        {deliveries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--aime-border)] px-3 py-4 text-xs text-[var(--aime-text-tertiary)]">
            暂无发送尝试。
          </p>
        ) : (
          deliveries.slice(0, 6).map((delivery) => (
            <div key={delivery.id} className="rounded-lg border border-[var(--aime-border)] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-[var(--aime-text-tertiary)]">
                  {delivery.source_message_id}
                </span>
                <StatusBadge status={delivery.status === "dead_letter" ? "failed" : delivery.status} kind="execution" />
              </div>
              <p className="mt-1 text-[11px] leading-5 text-[var(--aime-text-tertiary)]">
                尝试 {delivery.attempt_count} 次 · {delivery.updated_at ? formatDateTime(delivery.updated_at) : "暂无时间"}
              </p>
              {delivery.last_error && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-[var(--aime-danger)]">{delivery.last_error}</p>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function OnboardingStepRow({ step }: { step: AIMeOnboardingStep }) {
  return (
    <div className="flex gap-3 rounded-lg border border-[var(--aime-border)] px-3 py-3">
      {step.completed ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--aime-success)]" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-[var(--aime-text-tertiary)]" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">{step.title}</p>
        <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
          {step.description}
        </p>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  tone: "brand" | "info" | "warning" | "success" | "danger";
}) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <p className={cn("text-xs font-medium", toneClass(tone))}>{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="min-w-0 truncate font-mono text-2xl font-semibold leading-none tabular-nums">{value}</p>
        <p className="text-right text-xs text-[var(--aime-text-tertiary)]">{hint}</p>
      </div>
    </div>
  );
}

function InfoCell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="rounded-lg border border-[var(--aime-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--aime-text-tertiary)]">{label}</p>
      <p className={cn("mt-1 truncate text-xs font-semibold", tone === "danger" && "text-[var(--aime-danger)]")}>
        {value}
      </p>
    </div>
  );
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium",
        ready
          ? "border-[var(--aime-success-bg)] bg-[var(--aime-success-bg)] text-[var(--aime-success)]"
          : "border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
      )}
    >
      {ready ? <CheckCircle2 className="size-3.5" /> : <CircleDashed className="size-3.5" />}
      {ready ? "飞书已就绪" : "飞书待配置"}
    </span>
  );
}

function BudgetBadge({ status }: { status: string }) {
  const label = status === "exceeded" ? "已超预算" : status === "warning" ? "接近预算" : "预算正常";
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
        status === "exceeded" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        status === "warning" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        status !== "exceeded" && status !== "warning" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      )}
    >
      {label}
    </span>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const label = risk === "high" ? "高风险" : risk === "low" ? "低风险" : "中风险";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        risk === "high" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        risk === "medium" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        risk === "low" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      )}
    >
      {label}
    </span>
  );
}

function StatusBadge({ status, kind }: { status: string; kind: "approval" | "execution" }) {
  const label = kind === "approval" ? approvalStatusLabel(status) : executionStatusLabel(status);
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tone === "success" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
        tone === "warning" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        tone === "danger" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        tone === "info" && "bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
        tone === "neutral" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
      )}
    >
      {statusIcon(tone)}
      <span className="ml-1">{label}</span>
    </span>
  );
}

function statusIcon(tone: "success" | "warning" | "danger" | "info" | "neutral") {
  if (tone === "success") return <CheckCircle2 className="size-3" />;
  if (tone === "danger") return <XCircle className="size-3" />;
  if (tone === "info") return <Send className="size-3" />;
  if (tone === "warning") return <Sparkles className="size-3" />;
  return <ShieldCheck className="size-3" />;
}

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "approved" || status === "succeeded") return "success";
  if (status === "pending" || status === "not_started" || status === "observing") return "warning";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "running") return "info";
  return "neutral";
}

function approvalStatusLabel(status: string) {
  switch (status) {
    case "pending":
      return "待审批";
    case "approved":
      return "已批准";
    case "rejected":
      return "已驳回";
    case "observing":
      return "观察";
    case "taken_over":
      return "接管";
    case "not_created":
      return "未建审批";
    default:
      return status || "未知";
  }
}

function executionStatusLabel(status: string) {
  switch (status) {
    case "not_started":
      return "未执行";
    case "running":
      return "执行中";
    case "succeeded":
      return "已发送";
    case "failed":
      return "失败";
    case "skipped":
      return "跳过";
    default:
      return status || "未知";
  }
}

function gateReasonLabel(value: string) {
  switch (value) {
    case "owner_direct":
      return "直接消息";
    case "group_mention":
      return "群内提及";
    case "allowed_chat":
      return "白名单群";
    default:
      return value;
  }
}

function toneClass(tone: "brand" | "info" | "warning" | "success" | "danger") {
  switch (tone) {
    case "brand":
      return "text-[var(--aime-brand-600)]";
    case "info":
      return "text-[var(--aime-info)]";
    case "warning":
      return "text-[var(--aime-warning)]";
    case "success":
      return "text-[var(--aime-success)]";
    case "danger":
      return "text-[var(--aime-danger)]";
  }
}

function percentage(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatMoney(cents: number, currency: string) {
  const amount = cents / 100;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: amount >= 10 ? 2 : 4,
  }).format(amount);
}

function formatDateTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}
