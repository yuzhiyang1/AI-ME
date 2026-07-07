"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Clipboard,
  Database,
  ExternalLink,
  Inbox,
  ListChecks,
  Loader2,
  Send,
  ShieldAlert,
  Sparkles,
  UserCheck,
} from "lucide-react";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { aimeCockpitSummaryOptions, useThinkAIMe } from "@multica/core/aime";
import { approvalListOptions } from "@multica/core/approvals";
import { inboxListOptions, deduplicateInboxItems } from "@multica/core/inbox/queries";
import { memoryListOptions } from "@multica/core/memory";
import { agentListOptions } from "@multica/core/workspace";
import { issueListOptions } from "@multica/core/issues";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import type {
  AIMeMemoryContext,
  AIMeSuggestedAction,
  AIMeThinkIntent,
  AIMeThinkResponse,
  Agent,
  Issue,
} from "@multica/core/types";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multica/ui/components/ui/native-select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { PageHeader } from "../../layout/page-header";
import { AppLink } from "../../navigation";
import {
  buildCockpitQueues,
  describeDashboardTask,
  formatDashboardAge,
  taskProgressPercent,
  type CockpitQueues,
  type CockpitDecisionItem,
  type CockpitInboxItem,
  type CockpitWorkItem,
} from "./dashboard-data";

const INTENTS: { value: AIMeThinkIntent; label: string }[] = [
  { value: "triage", label: "判断优先级" },
  { value: "plan", label: "拆解任务" },
  { value: "assign", label: "分配员工" },
  { value: "reply", label: "生成回复" },
  { value: "general", label: "综合判断" },
];

const STARTERS = [
  "这件事应该交给 Codex 还是 Claude Code？请给我风险和下一步。",
  "帮我把这个需求拆成可以交给 AI 员工执行的 task。",
  "这段外部消息应该怎么回复？需要我审批哪些点？",
];

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_ISSUES: Issue[] = [];

export function AIMeDashboardPage() {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [input, setInput] = useState("");
  const [intent, setIntent] = useState<AIMeThinkIntent>("triage");
  const [lastResult, setLastResult] = useState<AIMeThinkResponse | null>(null);
  const think = useThinkAIMe();

  const agentsQuery = useQuery(agentListOptions(wsId));
  const issuesQuery = useQuery(issueListOptions(wsId));
  const summaryQuery = useQuery(aimeCockpitSummaryOptions(wsId));
  const approvalsQuery = useQuery(approvalListOptions(wsId, { status: "pending", limit: 20 }));
  const inboxQuery = useQuery(inboxListOptions(wsId));
  const taskSnapshotQuery = useQuery(agentTaskSnapshotOptions(wsId));
  const memoryCandidatesQuery = useQuery(memoryListOptions(wsId, { status: "candidate", limit: 12 }));
  const agents = agentsQuery.data ?? EMPTY_AGENTS;
  const issues = issuesQuery.data ?? EMPTY_ISSUES;
  const onlineAgents = agents.filter((agent) => agent.status !== "offline" && !agent.archived_at);
  const activeIssues = issues.filter((issue) => !["done", "cancelled"].includes(issue.status));

  const canSubmit = input.trim().length > 0 && !think.isPending;
  const result = think.data ?? lastResult;
  const injectedMemories = result?.context.memories ?? [];
  const summary = summaryQuery.data;
  const dedupedInbox = useMemo(
    () => deduplicateInboxItems(inboxQuery.data ?? []),
    [inboxQuery.data],
  );
  const cockpitQueues = useMemo(
    () =>
      buildCockpitQueues({
        approvals: approvalsQuery.data?.approvals ?? [],
        inboxItems: dedupedInbox,
        tasks: taskSnapshotQuery.data ?? [],
        agents,
        issues,
        memories: memoryCandidatesQuery.data?.memories ?? [],
      }),
    [
      approvalsQuery.data?.approvals,
      dedupedInbox,
      taskSnapshotQuery.data,
      agents,
      issues,
      memoryCandidatesQuery.data?.memories,
    ],
  );
  const cockpitLoading =
    approvalsQuery.isLoading ||
    inboxQuery.isLoading ||
    taskSnapshotQuery.isLoading ||
    memoryCandidatesQuery.isLoading;
  const cockpitError =
    firstErrorMessage(
      approvalsQuery.error,
      inboxQuery.error,
      taskSnapshotQuery.error,
      memoryCandidatesQuery.error,
    );

  async function handleSubmit() {
    const text = input.trim();
    if (!text) return;
    const next = await think.mutateAsync({
      input: text,
      intent,
      source_type: "manual",
      need_worker_plan: true,
    });
    setLastResult(next);
  }

  async function copyReplyDraft() {
    if (!result?.reply_draft) return;
    await navigator.clipboard.writeText(result.reply_draft);
    toast.success("已复制回复草稿");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)] text-[var(--aime-text)]">
      <PageHeader className="h-16 justify-between border-b border-[var(--aime-border)] bg-[var(--aime-surface)] px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BrainCircuit className="size-4 text-[var(--aime-brand-600)]" />
            <h1 className="truncate text-base font-semibold tracking-normal">AI-Me 指挥中枢</h1>
            <Badge variant="outline" className="border-[var(--aime-border)] text-[var(--aime-text-tertiary)]">
              建议态
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
            基于当前工作区、issue、AI 员工和已激活记忆生成判断。
          </p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <StatusPill configured={result?.configured} />
        </div>
      </PageHeader>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <section className="grid shrink-0 gap-3 lg:grid-cols-5">
          <MetricCard
            label="已自动完成"
            value={summary?.completed_tasks_today ?? 0}
            hint={`失败 ${summary?.failed_tasks_today ?? 0}`}
            tone="success"
          />
          <MetricCard
            label="进行中"
            value={summary?.active_tasks ?? 0}
            hint={`排队 ${summary?.queued_tasks ?? 0} / 执行 ${summary?.running_tasks ?? 0}`}
            tone="brand"
          />
          <MetricCard
            label="等待外部"
            value={summary?.waiting_external ?? 0}
            hint={`未读 ${summary?.unread_inbox ?? 0}`}
            tone="info"
          />
          <MetricCard
            label="需要我决策"
            value={summary?.pending_decisions ?? 0}
            hint={`外部回复 ${summary?.external_reply_pending ?? 0}`}
            tone="warning"
          />
          <MetricCard
            label="严重风险"
            value={summary?.high_risk_pending ?? 0}
            hint={`活跃 issue ${summary?.active_issues ?? activeIssues.length}`}
            tone="danger"
          />
        </section>

        <ExecutionSnapshot
          isLoading={summaryQuery.isLoading}
          error={summaryQuery.error instanceof Error ? summaryQuery.error.message : ""}
          succeeded={summary?.execution_succeeded ?? 0}
          failed={summary?.execution_failed ?? 0}
          assigned={summary?.assign_worker_succeeded ?? 0}
          replied={summary?.external_reply_succeeded ?? 0}
          activeMemories={summary?.active_memories ?? 0}
          memoryUsedToday={summary?.memory_used_today ?? 0}
          onlineAgents={onlineAgents.length}
          totalAgents={agents.length}
        />

        <section className="grid shrink-0 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
          <DecisionQueuePanel
            items={cockpitQueues.decisions}
            isLoading={cockpitLoading}
            error={cockpitError}
            approvalPath={(id) => paths.approvals(id)}
            className="xl:row-span-2"
          />
          <ActiveWorkPanel
            items={cockpitQueues.activeWork}
            isLoading={cockpitLoading}
            agentsPath={paths.agents()}
          />
          <InboxExceptionPanel
            items={cockpitQueues.inbox}
            isLoading={cockpitLoading}
            inboxPath={paths.inbox()}
          />
          <MemoryCandidatePanel
            items={cockpitQueues.memoryCandidates}
            isLoading={cockpitLoading}
            memoryPath={paths.memory()}
            className="xl:col-span-2"
          />
        </section>

        <section className="grid min-h-[560px] flex-1 gap-4 xl:grid-cols-[minmax(360px,430px)_minmax(0,1fr)_392px]">
          <div className="flex min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
            <div className="border-b border-[var(--aime-border)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">交给 AI-Me 判断</h2>
                  <p className="mt-1 text-xs text-[var(--aime-text-tertiary)]">
                    输入外部消息、需求或一个待处理问题。
                  </p>
                </div>
                <NativeSelect
                  size="sm"
                  value={intent}
                  onChange={(event) => setIntent(event.target.value as AIMeThinkIntent)}
                  className="w-32"
                >
                  {INTENTS.map((item) => (
                    <NativeSelectOption key={item.value} value={item.value}>
                      {item.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="例如：客户要求退款，但订单状态显示已经发货。帮我判断应该怎么处理。"
                className="min-h-48 resize-none rounded-xl border-[var(--aime-border-strong)] bg-[var(--aime-surface)] text-sm leading-6"
              />
              <div className="space-y-2">
                <p className="text-xs font-medium text-[var(--aime-text-tertiary)]">快速开始</p>
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => setInput(starter)}
                    className="block w-full rounded-lg border border-[var(--aime-border)] px-3 py-2 text-left text-xs leading-5 text-[var(--aime-text-secondary)] transition-colors hover:border-[var(--aime-brand-200)] hover:bg-[var(--aime-brand-50)]"
                  >
                    {starter}
                  </button>
                ))}
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--aime-border)] pt-4">
                <p className="text-xs leading-5 text-[var(--aime-text-tertiary)]">
                  第一版只生成建议，不会自动执行。
                </p>
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
                >
                  {think.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  生成建议
                </Button>
              </div>
            </div>
          </div>

          <DecisionPanel
            result={result}
            isPending={think.isPending}
            error={think.error instanceof Error ? think.error.message : ""}
            onCopyReply={copyReplyDraft}
            approvalPath={paths.approvals()}
          />

          <ContextPanel
            isLoading={agentsQuery.isLoading || issuesQuery.isLoading}
            agents={result?.context.agents ?? agents.map((agent) => ({
              id: agent.id,
              name: agent.name,
              description: agent.description,
              provider: "",
              status: agent.status,
              runtime_status: "",
              model: agent.model,
            }))}
            issues={result?.context.issues ?? activeIssues.slice(0, 8).map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
            }))}
            memories={injectedMemories}
          />
        </section>
      </main>
    </div>
  );
}

function StatusPill({ configured }: { configured?: boolean }) {
  if (configured === undefined) {
    return (
      <span className="inline-flex items-center gap-2 rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface)] px-3 py-1.5 text-xs font-medium text-[var(--aime-text-tertiary)]">
        <BrainCircuit className="size-3.5" />
        等待判断
      </span>
    );
  }
  if (configured === false) {
    return (
      <span className="inline-flex items-center gap-2 rounded-lg border border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] px-3 py-1.5 text-xs font-medium text-[var(--aime-warning)]">
        <AlertCircle className="size-3.5" />
        LLM 未配置
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-[var(--aime-success-bg)] bg-[var(--aime-success-bg)] px-3 py-1.5 text-xs font-medium text-[var(--aime-success)]">
      <CheckCircle2 className="size-3.5" />
      AI-Me 在线
    </span>
  );
}

function DecisionQueuePanel({
  items,
  isLoading,
  error,
  approvalPath,
  className,
}: {
  items: CockpitDecisionItem[];
  isLoading: boolean;
  error: string;
  approvalPath: (id: string) => string;
  className?: string;
}) {
  return (
    <PanelShell
      className={className}
      title="需要我决策"
      description="高风险审批、外部回复和派工确认会优先出现在这里。"
      icon={<UserCheck className="size-4 text-[var(--aime-brand-600)]" />}
      actionHref={approvalPath("")}
      actionLabel="审批中心"
    >
      {error ? (
        <InlineError message={error} />
      ) : isLoading ? (
        <LoadingRows count={4} />
      ) : items.length === 0 ? (
        <EmptyQueue
          icon={<CheckCircle2 className="size-5" />}
          title="暂无待决策事项"
          description="AI-Me 需要你确认的动作会沉淀到这里。"
        />
      ) : (
        <div className="space-y-3">
          {items.slice(0, 6).map(({ approval, issue }) => (
            <AppLink
              key={approval.id}
              href={approvalPath(approval.id)}
              className="block rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-3 transition-colors hover:border-[var(--aime-brand-200)] hover:bg-[var(--aime-brand-50)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <RiskBadge risk={approval.risk_level} />
                    <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                      {actionLabel(approval.action_type)}
                    </span>
                    {issue && (
                      <span className="font-mono text-[11px] text-[var(--aime-text-tertiary)]">
                        {issue.identifier}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-1 text-sm font-semibold text-[var(--aime-text)]">
                    {approval.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
                    {approval.summary || approval.action_description || "等待你确认下一步处理方式。"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm font-semibold tabular-nums text-[var(--aime-text)]">
                    {Math.round(approval.confidence * 100)}%
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--aime-text-tertiary)]">
                    {formatDashboardAge(approval.created_at)}
                  </p>
                </div>
              </div>
            </AppLink>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function ActiveWorkPanel({
  items,
  isLoading,
  agentsPath,
}: {
  items: CockpitWorkItem[];
  isLoading: boolean;
  agentsPath: string;
}) {
  return (
    <PanelShell
      title="AI 员工正在做"
      description="来自 agent task snapshot，不再使用页面 demo 数据。"
      icon={<Bot className="size-4 text-[var(--aime-info)]" />}
      actionHref={agentsPath}
      actionLabel="员工页"
    >
      {isLoading ? (
        <LoadingRows count={3} />
      ) : items.length === 0 ? (
        <EmptyQueue
          icon={<Clock3 className="size-5" />}
          title="暂无进行中任务"
          description="有员工接到任务后会显示实时状态。"
        />
      ) : (
        <div className="space-y-3">
          {items.slice(0, 4).map(({ task, agent, issue }) => {
            const progress = taskProgressPercent(task.status);
            return (
              <div key={task.id} className="rounded-xl border border-[var(--aime-border)] px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {agent?.name ?? "未知员工"}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
                      {describeDashboardTask(task, issue)}
                    </p>
                  </div>
                  <TaskStatusPill status={task.status} />
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--aime-brand-100)]">
                  <div
                    className="h-full rounded-full bg-[var(--aime-brand-500)]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--aime-text-tertiary)]">
                  <span>{task.work_dir || task.trigger_summary || "等待运行日志"}</span>
                  <span className="shrink-0">{formatDashboardAge(task.started_at ?? task.dispatched_at ?? task.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PanelShell>
  );
}

function InboxExceptionPanel({
  items,
  isLoading,
  inboxPath,
}: {
  items: CockpitInboxItem[];
  isLoading: boolean;
  inboxPath: string;
}) {
  return (
    <PanelShell
      title="例外收件箱"
      description="外部消息、失败任务和需要注意的事件。"
      icon={<Inbox className="size-4 text-[var(--aime-warning)]" />}
      actionHref={inboxPath}
      actionLabel="收件箱"
    >
      {isLoading ? (
        <LoadingRows count={3} />
      ) : items.length === 0 ? (
        <EmptyQueue
          icon={<CheckCircle2 className="size-5" />}
          title="暂无例外"
          description="所有外部事件都已经处理或无需关注。"
        />
      ) : (
        <div className="space-y-2">
          {items.slice(0, 5).map(({ item, issue }) => (
            <AppLink
              key={item.id}
              href={inboxPath}
              className="flex items-start justify-between gap-3 rounded-xl border border-[var(--aime-border)] px-3 py-2.5 transition-colors hover:border-[var(--aime-brand-200)] hover:bg-[var(--aime-brand-50)]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {!item.read && <span className="size-1.5 shrink-0 rounded-full bg-[var(--aime-brand-500)]" />}
                  <p className="truncate text-sm font-semibold">{item.title}</p>
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-[var(--aime-text-secondary)]">
                  {item.body || issue?.title || "等待查看详情。"}
                </p>
                <p className="mt-1 text-[11px] text-[var(--aime-text-tertiary)]">
                  {issue?.identifier ?? severityLabel(item.severity)} · {formatDashboardAge(item.created_at)}
                </p>
              </div>
              <SeverityBadge severity={item.severity} />
            </AppLink>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function MemoryCandidatePanel({
  items,
  isLoading,
  memoryPath,
  className,
}: {
  items: CockpitQueues["memoryCandidates"];
  isLoading: boolean;
  memoryPath: string;
  className?: string;
}) {
  return (
    <PanelShell
      className={className}
      title="待确认记忆"
      description="先作为候选保存，确认后才会进入 AI-Me 的可注入上下文。"
      icon={<Database className="size-4 text-[var(--aime-success)]" />}
      actionHref={memoryPath}
      actionLabel="记忆库"
    >
      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : items.length === 0 ? (
        <EmptyQueue
          icon={<BrainCircuit className="size-5" />}
          title="暂无候选记忆"
          description="AI-Me 发现稳定偏好或项目事实后会先放在这里。"
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {items.slice(0, 3).map((memory) => (
            <AppLink
              key={memory.id}
              href={memoryPath}
              className="rounded-xl border border-[var(--aime-border)] px-3 py-3 transition-colors hover:border-[var(--aime-brand-200)] hover:bg-[var(--aime-brand-50)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                  {memoryTypeLabel(memory.type)}
                </span>
                <span className="font-mono text-[11px] text-[var(--aime-text-tertiary)]">
                  {Math.round(memory.confidence * 100)}%
                </span>
              </div>
              <p className="mt-2 line-clamp-1 text-sm font-semibold">{memory.title}</p>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
                {memory.summary || memory.content}
              </p>
            </AppLink>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function PanelShell({
  title,
  description,
  icon,
  actionHref,
  actionLabel,
  className,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  actionHref: string;
  actionLabel: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-[var(--aime-border)] p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--aime-surface-subtle)]">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-tertiary)]">
              {description}
            </p>
          </div>
        </div>
        <AppLink
          href={actionHref}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--aime-text-secondary)] hover:bg-[var(--aime-surface-muted)]"
        >
          {actionLabel}
          <ExternalLink className="size-3" />
        </AppLink>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </section>
  );
}

function LoadingRows({ count }: { count: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className="h-20 rounded-xl" />
      ))}
    </div>
  );
}

function EmptyQueue({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--aime-border)] px-4 py-6 text-center text-[var(--aime-text-tertiary)]">
      <span className="flex size-10 items-center justify-center rounded-xl bg-[var(--aime-surface-subtle)]">
        {icon}
      </span>
      <p className="mt-3 text-sm font-medium text-[var(--aime-text)]">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-5">{description}</p>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <Alert className="border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)]">
      <AlertCircle className="size-4 text-[var(--aime-warning)]" />
      <AlertTitle>队列暂不可用</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function TaskStatusPill({ status }: { status: CockpitWorkItem["task"]["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        status === "running" && "bg-[var(--aime-brand-50)] text-[var(--aime-brand-600)]",
        status === "dispatched" && "bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
        status === "queued" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
      )}
    >
      {taskStatusLabel(status)}
    </span>
  );
}

function DecisionPanel({
  result,
  isPending,
  error,
  onCopyReply,
  approvalPath,
}: {
  result: AIMeThinkResponse | null;
  isPending: boolean;
  error: string;
  onCopyReply: () => void;
  approvalPath: string;
}) {
  if (isPending) {
    return (
      <section className="flex min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-4 h-20 w-full" />
        <Skeleton className="mt-3 h-36 w-full" />
        <Skeleton className="mt-3 h-28 w-full" />
      </section>
    );
  }
  if (error) {
    return (
      <section className="flex min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>无法生成建议</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </section>
    );
  }
  if (!result) {
    return (
      <section className="flex min-h-0 flex-col items-center justify-center rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] px-8 py-10 text-center shadow-[var(--aime-shadow-xs)]">
        <BrainCircuit className="size-10 text-[var(--aime-text-tertiary)]" />
        <h2 className="mt-4 text-sm font-semibold">等待你的输入</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--aime-text-tertiary)]">
          AI-Me 会先给出判断、风险、建议动作和可分配员工；真正执行仍然需要你确认。
        </p>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--aime-border)] p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">AI 判断</h2>
            <RiskBadge risk={result.risk_level} />
            {result.need_approval && (
              <Badge variant="outline" className="border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]">
                需要审批
              </Badge>
            )}
            {result.approval_id && (
              <Badge variant="outline" className="border-[var(--aime-success-bg)] bg-[var(--aime-success-bg)] text-[var(--aime-success)]">
                已送审批中心
              </Badge>
            )}
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--aime-text-secondary)]">
            {result.summary}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-lg font-semibold tabular-nums">
            {Math.round(result.confidence * 100)}%
          </p>
          <p className="text-xs text-[var(--aime-text-tertiary)]">置信度</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {result.configuration_required && (
          <Alert className="border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)]">
            <AlertCircle className="size-4 text-[var(--aime-warning)]" />
            <AlertTitle>还不能调用 LLM</AlertTitle>
            <AlertDescription>
              需要在后端配置 AI_ME_LLM_API_KEY 和 AI_ME_LLM_MODEL，重启服务后即可启用真实判断。
            </AlertDescription>
          </Alert>
        )}

        {result.approval_id && (
          <section className="flex items-center justify-between gap-3 rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">审批已创建</p>
              <p className="mt-1 truncate font-mono text-xs text-[var(--aime-text-tertiary)]">
                {result.approval_id}
              </p>
            </div>
            <AppLink
              href={approvalPath}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface)] px-3 py-2 text-xs font-medium text-[var(--aime-text)] shadow-[var(--aime-shadow-xs)] hover:bg-[var(--aime-surface-muted)]"
            >
              查看审批
              <ArrowRight className="size-3.5" />
            </AppLink>
          </section>
        )}

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">
            <ShieldAlert className="size-3.5" />
            判断摘要
          </h3>
          <p className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-3 text-sm leading-6 text-[var(--aime-text-secondary)]">
            {result.reasoning_summary || "暂无额外说明。"}
          </p>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">
            <ListChecks className="size-3.5" />
            建议动作
          </h3>
          <div className="space-y-2">
            {result.actions.map((action, index) => (
              <ActionRow key={`${action.type}-${index}`} action={action} />
            ))}
          </div>
        </section>

        {result.reply_draft && (
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">
                <Send className="size-3.5" />
                回复草稿
              </h3>
              <Button type="button" variant="outline" size="sm" onClick={onCopyReply}>
                <Clipboard className="size-3.5" />
                复制
              </Button>
            </div>
            <p className="rounded-xl border border-[var(--aime-border)] px-3 py-3 text-sm leading-6 text-[var(--aime-text-secondary)] whitespace-pre-wrap">
              {result.reply_draft}
            </p>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">证据</h3>
          {result.evidence.length > 0 ? (
            <div className="space-y-2">
              {result.evidence.map((item, index) => (
                <div key={`${item.type}-${index}`} className="rounded-xl border border-[var(--aime-border)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    <span className="shrink-0 rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                      {item.type}
                    </span>
                  </div>
                  {item.quote && (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-tertiary)]">
                      {item.quote}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
              暂无证据条目。
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

function ContextPanel({
  isLoading,
  agents,
  issues,
  memories,
}: {
  isLoading: boolean;
  agents: { id: string; name: string; provider: string; status: string; runtime_status: string; model?: string }[];
  issues: { id: string; identifier: string; title: string; status: string; priority: string }[];
  memories: AIMeMemoryContext[];
}) {
  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)] xl:flex">
      <div className="border-b border-[var(--aime-border)] p-4">
        <h2 className="text-sm font-semibold">实时上下文</h2>
        <p className="mt-1 text-xs text-[var(--aime-text-tertiary)]">
          本次判断只使用这些实时数据和可治理记忆。
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
        {isLoading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </>
        ) : (
          <>
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">
                <Bot className="size-3.5" />
                AI 员工
              </h3>
              <div className="space-y-2">
                {agents.slice(0, 8).map((agent) => (
                  <div key={agent.id} className="rounded-xl border border-[var(--aime-border)] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium">{agent.name}</p>
                      <span className="shrink-0 text-[11px] text-[var(--aime-text-tertiary)]">
                        {agent.provider || "provider 未知"}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--aime-text-tertiary)]">
                      {agent.status} / {agent.runtime_status || "runtime 未知"}
                      {agent.model ? ` / ${agent.model}` : ""}
                    </p>
                  </div>
                ))}
                {agents.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
                    当前工作区还没有可调度智能体。
                  </p>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">活跃 issue</h3>
              <div className="space-y-2">
                {issues.slice(0, 8).map((issue) => (
                  <div key={issue.id} className="rounded-xl border border-[var(--aime-border)] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium">{issue.identifier}</p>
                      <span className="shrink-0 rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                        {issue.priority}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
                      {issue.title}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--aime-text-tertiary)]">{issue.status}</p>
                  </div>
                ))}
                {issues.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
                    当前没有活跃 issue。
                  </p>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">
                <BrainCircuit className="size-3.5" />
                已注入记忆
              </h3>
              <div className="space-y-2">
                {memories.slice(0, 6).map((memory) => (
                  <div key={memory.id} className="rounded-xl border border-[var(--aime-border)] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium">{memory.title}</p>
                      <span className="shrink-0 rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                        {memory.external_use_policy}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
                      {memory.summary || memory.content}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--aime-text-tertiary)]">
                      {memory.type} / {memory.scope_type} / {Math.round(memory.confidence * 100)}%
                    </p>
                  </div>
                ))}
                {memories.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
                    本次判断没有可注入的 active 记忆。
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function ExecutionSnapshot({
  isLoading,
  error,
  succeeded,
  failed,
  assigned,
  replied,
  activeMemories,
  memoryUsedToday,
  onlineAgents,
  totalAgents,
}: {
  isLoading: boolean;
  error: string;
  succeeded: number;
  failed: number;
  assigned: number;
  replied: number;
  activeMemories: number;
  memoryUsedToday: number;
  onlineAgents: number;
  totalAgents: number;
}) {
  if (error) {
    return (
      <Alert className="shrink-0 border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)]">
        <AlertCircle className="size-4 text-[var(--aime-warning)]" />
        <AlertTitle>统计暂不可用</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const items = [
    { label: "执行成功", value: succeeded, tone: "success" },
    { label: "执行失败", value: failed, tone: "danger" },
    { label: "派工成功", value: assigned, tone: "brand" },
    { label: "外部回复", value: replied, tone: "info" },
    { label: "活跃记忆", value: activeMemories, tone: "neutral" },
    { label: "今日调用", value: memoryUsedToday, tone: "warning" },
    { label: "在线员工", value: `${onlineAgents}/${totalAgents}`, tone: "brand" },
  ] as const;

  return (
    <section className="grid shrink-0 gap-2 rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] px-3 py-3 shadow-[var(--aime-shadow-xs)] md:grid-cols-7">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
          <p className={cn("truncate text-[11px] font-medium", toneClass(item.tone))}>{item.label}</p>
          {isLoading ? (
            <Skeleton className="mt-2 h-5 w-14" />
          ) : (
            <p className="mt-1 font-mono text-sm font-semibold tabular-nums">{item.value}</p>
          )}
        </div>
      ))}
    </section>
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
  tone: "brand" | "info" | "warning" | "neutral" | "success" | "danger";
}) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <p className={cn("text-xs font-medium", toneClass(tone))}>{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="font-mono text-2xl font-semibold leading-none tabular-nums">{value}</p>
        <p className="text-right text-xs text-[var(--aime-text-tertiary)]">{hint}</p>
      </div>
    </div>
  );
}

function ActionRow({ action }: { action: AIMeSuggestedAction }) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{action.title}</p>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-secondary)]">
            {action.description}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
            {actionLabel(action.type)}
          </span>
          {action.requires_approval && (
            <span className="rounded-md bg-[var(--aime-warning-bg)] px-1.5 py-0.5 text-[11px] text-[var(--aime-warning)]">
              审批
            </span>
          )}
        </div>
      </div>
      {(action.target_agent_name || action.priority) && (
        <p className="mt-2 text-[11px] text-[var(--aime-text-tertiary)]">
          {action.target_agent_name ? `建议员工：${action.target_agent_name}` : ""}
          {action.target_agent_name && action.priority ? " · " : ""}
          {action.priority ? `优先级：${action.priority}` : ""}
        </p>
      )}
    </div>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const label = risk === "high" ? "高风险" : risk === "low" ? "低风险" : "中风险";
  return (
    <Badge
      variant="outline"
      className={cn(
        risk === "high" && "border-[var(--aime-danger-bg)] bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        risk === "medium" && "border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        risk === "low" && "border-[var(--aime-success-bg)] bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      )}
    >
      {label}
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        severity === "action_required" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        severity === "attention" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        severity === "info" && "bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
      )}
    >
      {severityLabel(severity)}
    </span>
  );
}

function firstErrorMessage(...errors: unknown[]): string {
  const error = errors.find(Boolean);
  if (!error) return "";
  return error instanceof Error ? error.message : "数据加载失败";
}

function severityLabel(severity: string): string {
  switch (severity) {
    case "action_required":
      return "需处理";
    case "attention":
      return "关注";
    case "info":
      return "信息";
    default:
      return "未知";
  }
}

function taskStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "执行中";
    case "dispatched":
      return "已派发";
    case "queued":
      return "排队中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "未知";
  }
}

function memoryTypeLabel(type: string): string {
  switch (type) {
    case "identity":
      return "身份";
    case "preference":
      return "偏好";
    case "rule":
      return "规则";
    case "project_fact":
      return "项目事实";
    case "process":
      return "流程";
    case "history":
      return "历史";
    case "relationship":
      return "关系";
    case "technical_context":
      return "技术上下文";
    default:
      return "记忆";
  }
}

function actionLabel(type: string) {
  switch (type) {
    case "create_issue":
      return "创建 issue";
    case "create_task":
      return "创建 task";
    case "assign_worker":
      return "分配员工";
    case "draft_reply":
      return "回复草稿";
    case "send_external_message":
      return "外部发送";
    case "post_internal_comment":
      return "内部评论";
    case "confirm_memory":
      return "确认记忆";
    case "no_action":
      return "无需动作";
    default:
      return "询问用户";
  }
}

function toneClass(tone: "brand" | "info" | "warning" | "neutral" | "success" | "danger") {
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
    default:
      return "text-[var(--aime-text-tertiary)]";
  }
}
