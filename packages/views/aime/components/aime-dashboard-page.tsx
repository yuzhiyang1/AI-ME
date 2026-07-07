"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clipboard,
  ListChecks,
  Loader2,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { aimeCockpitSummaryOptions, useThinkAIMe } from "@multica/core/aime";
import { agentListOptions } from "@multica/core/workspace";
import { issueListOptions } from "@multica/core/issues";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import type {
  AIMeMemoryContext,
  AIMeSuggestedAction,
  AIMeThinkIntent,
  AIMeThinkResponse,
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
  const agents = agentsQuery.data ?? [];
  const issues = issuesQuery.data ?? [];
  const onlineAgents = agents.filter((agent) => agent.status !== "offline" && !agent.archived_at);
  const activeIssues = issues.filter((issue) => !["done", "cancelled"].includes(issue.status));

  const canSubmit = input.trim().length > 0 && !think.isPending;
  const result = think.data ?? lastResult;
  const injectedMemories = result?.context.memories ?? [];
  const summary = summaryQuery.data;

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

        <section className="grid min-h-[620px] flex-1 gap-4 xl:grid-cols-[minmax(360px,430px)_minmax(0,1fr)_392px]">
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

function actionLabel(type: string) {
  switch (type) {
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
