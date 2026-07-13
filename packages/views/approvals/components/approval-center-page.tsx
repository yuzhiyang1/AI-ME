"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Eye,
  FileText,
  Hand,
  Loader2,
  RotateCcw,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { api } from "@multica/core/api";
import {
  approvalDetailOptions,
  approvalListOptions,
  approvalStatsOptions,
  useApproveAIApproval,
  useObserveAIApproval,
  useRateAIApproval,
  useRejectAIApproval,
  useRetryAIApprovalExecution,
  useTakeOverAIApproval,
} from "@multica/core/approvals";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueKeys } from "@multica/core/issues/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import type {
  AIApproval,
  AIApprovalStats,
  AIApprovalActionType,
  AIApprovalStatus,
  AgentTask,
  ListAIApprovalsParams,
} from "@multica/core/types";
import { useActorName } from "@multica/core/workspace/hooks";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { PageHeader } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";

type ApprovalTabKey = "pending" | "approved" | "rejected" | "history";
type ApprovalFilterKey = "all" | "high" | "external" | "create" | "assign" | "memory" | "failed";

const EMPTY_APPROVALS: AIApproval[] = [];
const EMPTY_STATS: AIApprovalStats = {
  total: 0,
  pending: 0,
  high_risk_pending: 0,
  observing: 0,
  approved: 0,
  rejected: 0,
  taken_over: 0,
  expired: 0,
  succeeded: 0,
  failed: 0,
};

const APPROVAL_TABS: { key: ApprovalTabKey; label: string; status?: AIApprovalStatus }[] = [
  { key: "pending", label: "待审批", status: "pending" },
  { key: "approved", label: "已批准", status: "approved" },
  { key: "rejected", label: "已驳回", status: "rejected" },
  { key: "history", label: "历史记录" },
];

const FILTERS: { key: ApprovalFilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "high", label: "高风险" },
  { key: "external", label: "对外动作" },
  { key: "create", label: "创建任务" },
  { key: "assign", label: "分配员工" },
  { key: "memory", label: "记忆确认" },
  { key: "failed", label: "失败重试" },
];

const EXECUTABLE_ACTION_TYPES = new Set<string>([
  "create_issue",
  "assign_worker",
  "draft_reply",
  "send_external_message",
  "post_internal_comment",
  "no_action",
]);

const EDITABLE_APPROVAL_ACTION_TYPES = new Set<string>([
  "draft_reply",
  "send_external_message",
  "post_internal_comment",
]);

const EDITABLE_PAYLOAD_TEXT_KEYS = [
  "text",
  "content",
  "reply_text",
  "reply_draft",
  "draft",
  "body",
];

export function ApprovalCenterPage() {
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const { searchParams, replace } = useNavigation();
  const requestedApprovalId = searchParams.get("approval") ?? "";
  const [tab, setTab] = useState<ApprovalTabKey>("pending");
  const [filter, setFilter] = useState<ApprovalFilterKey>("all");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => requestedApprovalId || null,
  );

  const params = useMemo<ListAIApprovalsParams>(() => {
    const current = APPROVAL_TABS.find((item) => item.key === tab);
    const next: ListAIApprovalsParams = { limit: 80 };
    if (current?.status) next.status = current.status;
    if (filter === "high") next.risk_level = "high";
    if (filter === "create") next.action_type = "create_issue";
    if (filter === "assign") next.action_type = "assign_worker";
    if (filter === "memory") next.action_type = "confirm_memory";
    return next;
  }, [filter, tab]);

  const approvalQuery = useQuery(approvalListOptions(wsId, params));
  const statsQuery = useQuery(approvalStatsOptions(wsId));
  const approvals = approvalQuery.data?.approvals ?? EMPTY_APPROVALS;
  const filteredApprovals = useMemo(
    () => applyClientFilter(approvals, filter),
    [approvals, filter],
  );

  useEffect(() => {
    if (requestedApprovalId) setSelectedId(requestedApprovalId);
  }, [requestedApprovalId]);

  useEffect(() => {
    // Keep a deep-linked approval selected even before it appears in the
    // current queue page; the detail query below can still resolve it by id.
    if (requestedApprovalId && selectedId === requestedApprovalId) return;
    if (filteredApprovals.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filteredApprovals.some((item) => item.id === selectedId)) {
      setSelectedId(filteredApprovals[0]?.id ?? null);
    }
  }, [filteredApprovals, requestedApprovalId, selectedId]);

  const handleSelectApproval = useCallback(
    (id: string) => {
      setSelectedId(id);
      replace(wsPaths.approvals(id));
    },
    [replace, wsPaths],
  );

  const detailQuery = useQuery({
    ...approvalDetailOptions(wsId, selectedId ?? ""),
    enabled: !!selectedId,
  });
  const selectedApproval =
    detailQuery.data?.id
      ? detailQuery.data
      : filteredApprovals.find((item) => item.id === selectedId) ?? null;
  const stats = statsQuery.data ?? EMPTY_STATS;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)] text-[var(--aime-text)]">
      <PageHeader className="h-16 justify-between border-b border-[var(--aime-border)] bg-[var(--aime-surface)] px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-[var(--aime-brand-600)]" />
            <h1 className="truncate text-base font-semibold tracking-normal">审批中心</h1>
            <Badge variant="outline" className="border-[var(--aime-border)] text-[var(--aime-text-tertiary)]">
              安全闸门
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
            所有代表你对外发送、创建或调度的高影响动作，都在这里确认。
          </p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <StatusMetric label="待审批" value={stats.pending} tone="brand" />
          <StatusMetric label="高风险" value={stats.high_risk_pending} tone="danger" />
        </div>
      </PageHeader>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <section className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="待我决策" value={stats.pending} hint="pending" tone="brand" />
          <MetricCard label="高风险" value={stats.high_risk_pending} hint="需要谨慎确认" tone="danger" />
          <MetricCard label="继续观察" value={stats.observing} hint="暂不执行" tone="warning" />
          <MetricCard label="执行成功" value={stats.succeeded} hint="已完成闭环" tone="success" />
          <MetricCard label="执行失败" value={stats.failed} hint="需要接管或重试" tone="danger" />
        </section>

        <section className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--aime-border)] pb-2">
          <div className="flex flex-wrap items-center gap-2">
            {APPROVAL_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cn(
                  "h-8 rounded-lg px-3 text-sm font-medium transition-colors",
                  tab === item.key
                    ? "bg-[var(--aime-brand-50)] text-[var(--aime-brand-700)]"
                    : "text-[var(--aime-text-tertiary)] hover:bg-[var(--aime-surface-muted)] hover:text-[var(--aime-text)]",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={cn(
                  "h-7 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                  filter === item.key
                    ? "border-[var(--aime-brand-200)] bg-[var(--aime-brand-50)] text-[var(--aime-brand-700)]"
                    : "border-[var(--aime-border)] bg-[var(--aime-surface)] text-[var(--aime-text-tertiary)] hover:bg-[var(--aime-surface-muted)]",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        <section className="grid min-h-[650px] flex-1 grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_340px]">
          <ApprovalQueue
            approvals={filteredApprovals}
            selectedId={selectedId}
            loading={approvalQuery.isLoading}
            error={approvalQuery.error}
            onSelect={handleSelectApproval}
          />
          <ApprovalDetail approval={selectedApproval} loading={detailQuery.isLoading} />
          <ApprovalRiskPanel
            approval={selectedApproval}
            loading={
              !!selectedId &&
              detailQuery.isLoading &&
              (selectedApproval?.evidence ?? []).length === 0 &&
              (selectedApproval?.events ?? []).length === 0
            }
          />
        </section>
      </main>
    </div>
  );
}

function ApprovalQueue({
  approvals,
  selectedId,
  loading,
  error,
  onSelect,
}: {
  approvals: AIApproval[];
  selectedId: string | null;
  loading: boolean;
  error: unknown;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--aime-border)] px-4">
        <h2 className="text-sm font-semibold">待审批队列</h2>
        <span className="text-xs text-[var(--aime-text-tertiary)]">按风险与时间排序</span>
      </div>
      {loading ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorBlock error={error} />
      ) : approvals.length === 0 ? (
        <QueueEmpty />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {approvals.map((approval) => (
            <button
              key={approval.id}
              type="button"
              onClick={() => onSelect(approval.id)}
              className={cn(
                "grid w-full grid-cols-[36px_minmax(0,1fr)_auto] gap-3 border-b border-[var(--aime-border)] px-4 py-4 text-left transition-colors",
                selectedId === approval.id
                  ? "bg-[var(--aime-brand-50)] ring-1 ring-inset ring-[var(--aime-brand-200)]"
                  : "hover:bg-[var(--aime-surface-subtle)]",
              )}
            >
              <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--aime-brand-50)] text-[var(--aime-brand-600)]">
                {actionIcon(approval.action_type)}
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold text-[var(--aime-text)]">
                    {approval.title}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-[var(--aime-text-tertiary)]">
                  {sourceLabel(approval.source_type)} · {actionLabel(approval.action_type)}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <RiskBadge risk={approval.risk_level} />
                  <ExecutionBadge status={approval.execution_status} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-[11px] text-[var(--aime-text-tertiary)]">
                  {formatRelative(approval.created_at)}
                </p>
                <p className="mt-2 font-mono text-xs font-semibold tabular-nums">
                  {Math.round(approval.confidence * 100)}%
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

function ApprovalDetail({ approval, loading }: { approval: AIApproval | null; loading: boolean }) {
  const [isEditingPayload, setIsEditingPayload] = useState(false);
  const [editedPayloadText, setEditedPayloadText] = useState("");
  const approveApproval = useApproveAIApproval();
  const rejectApproval = useRejectAIApproval();
  const observeApproval = useObserveAIApproval();
  const takeOverApproval = useTakeOverAIApproval();

  useLayoutEffect(() => {
    if (!approval) {
      setIsEditingPayload(false);
      setEditedPayloadText("");
      return;
    }
    setIsEditingPayload(false);
    setEditedPayloadText(getEditableApprovalText(approval));
  }, [approval?.id]);

  if (loading && !approval) {
    return (
      <section className="flex min-h-0 flex-col rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-28 w-full rounded-xl" />
        <Skeleton className="mt-3 h-40 w-full rounded-xl" />
      </section>
    );
  }
  if (!approval) {
    return (
      <section className="flex min-h-0 flex-col items-center justify-center rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] px-8 text-center shadow-[var(--aime-shadow-xs)]">
        <Sparkles className="size-10 text-[var(--aime-text-tertiary)]" />
        <h2 className="mt-4 text-sm font-semibold">暂无待审批事项</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--aime-text-tertiary)]">
          AI-Me 只有在需要你确认安全边界时，才会把动作放到这里。
        </p>
      </section>
    );
  }

  const canTransition = approval.status === "pending" || approval.status === "observing";
  const canExecuteAction = EXECUTABLE_ACTION_TYPES.has(approval.action_type);
  const awaitingTaskResult = approvalAwaitsTaskResult(approval);
  const canApprove = canTransition && canExecuteAction && !awaitingTaskResult;
  const canEditPayload = canApprove && isEditableApproval(approval);
  const editablePayloadKey = getEditableApprovalPayloadKey(approval);
  const currentEditableText = getEditableApprovalText(approval);
  const editedFinalPayload = buildEditedApprovalPayload(approval, editedPayloadText);
  const busy =
    approveApproval.isPending ||
    rejectApproval.isPending ||
    observeApproval.isPending ||
    takeOverApproval.isPending;

  const approve = async (edited: boolean) => {
    if (!canExecuteAction) {
      toast.error("这个动作会在 Phase 2 接入执行器");
      return;
    }
    if (edited && !canEditPayload) {
      toast.error("这个动作暂不支持编辑后批准");
      return;
    }
    if (edited && !editedPayloadText.trim()) {
      toast.error("回复正文不能为空");
      return;
    }
    try {
      await approveApproval.mutateAsync({
        id: approval.id,
        data: {
          note: edited ? "编辑后批准" : "批准",
          final_payload: edited ? editedFinalPayload : (approval.final_payload ?? {}),
        },
      });
      toast.success("审批已通过");
      setIsEditingPayload(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审批失败");
    }
  };

  const reject = async () => {
    const reason = window.prompt("驳回原因", "");
    if (reason === null) return;
    try {
      await rejectApproval.mutateAsync({ id: approval.id, data: { reason } });
      toast.success("已驳回审批");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "驳回失败");
    }
  };

  const observe = async () => {
    try {
      await observeApproval.mutateAsync({ id: approval.id, data: { note: "继续观察" } });
      toast.success("已设为继续观察");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  };

  const takeOver = async () => {
    try {
      await takeOverApproval.mutateAsync({ id: approval.id, data: { note: "用户接管" } });
      toast.success("已接管该审批事项");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "接管失败");
    }
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
      <div className="shrink-0 border-b border-[var(--aime-border)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={approval.status} />
              <RiskBadge risk={approval.risk_level} />
              <span className="rounded-md bg-[var(--aime-surface-muted)] px-2 py-0.5 text-xs text-[var(--aime-text-tertiary)]">
                {sourceLabel(approval.source_type)}
              </span>
            </div>
            <h2 className="mt-3 text-lg font-semibold leading-7">{approval.title}</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--aime-text-secondary)]">
              {approval.summary || approval.action_description || "AI-Me 未提供额外摘要。"}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {Math.round(approval.confidence * 100)}%
            </p>
            <p className="text-xs text-[var(--aime-text-tertiary)]">置信度</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] p-4">
          <h3 className="text-sm font-semibold">将要执行的动作</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <InfoCell label="动作类型" value={actionLabel(approval.action_type)} />
            <InfoCell label="可回滚性" value={reversibilityLabel(approval.reversibility)} />
            <InfoCell label="执行状态" value={executionLabel(approval.execution_status)} />
          </div>
          <p className="mt-3 text-sm leading-6 text-[var(--aime-text-secondary)]">
            {approval.action_description || approval.action_title || "暂无动作说明。"}
          </p>
        </section>

        <ApprovalSourceTrace approval={approval} />
        <ApprovalFailureNotice approval={approval} />
        <ApprovalExecutionPanel approval={approval} />

        {awaitingTaskResult && (
          <section className="flex items-start gap-3 rounded-xl border border-[var(--aime-warning-border)] bg-[var(--aime-warning-bg)] p-4">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-[var(--aime-warning)]" />
            <div>
              <h3 className="text-sm font-semibold">等待员工执行结果</h3>
              <p className="mt-1 text-xs leading-5 text-[var(--aime-text-secondary)]">
                员工完成后，AI-Me 会自动复核结果并更新这份回复草稿，届时才可批准发送。
              </p>
            </div>
          </section>
        )}

        {isEditableApproval(approval) && (
          <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">
                  {isEditingPayload ? "编辑后发送内容" : "拟发送内容"}
                </h3>
                <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
                  将写入 final_payload.{editablePayloadKey}，其他字段保持不变。
                </p>
              </div>
              {isEditingPayload && (
                <span className="rounded-md bg-[var(--aime-brand-50)] px-2 py-1 text-xs font-medium text-[var(--aime-brand-700)]">
                  待你确认
                </span>
              )}
            </div>
            {isEditingPayload ? (
              <Textarea
                aria-label="编辑后发送内容"
                value={editedPayloadText}
                onChange={(event) => setEditedPayloadText(event.target.value)}
                className="mt-3 min-h-40 resize-y rounded-lg border-[var(--aime-border-strong)] bg-[var(--aime-surface)] text-sm leading-6"
              />
            ) : (
              <div className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] p-3 text-sm leading-6 text-[var(--aime-text-secondary)]">
                {currentEditableText || "AI-Me 未生成可编辑正文。"}
              </div>
            )}
          </section>
        )}

        <section className="grid gap-4 lg:grid-cols-2">
          <PayloadBlock
            title="原始 payload"
            value={approval.original_payload}
            note="原始 payload 只读，用于审计和回溯。"
          />
          <PayloadBlock
            title={isEditingPayload ? "最终 payload（将随审批提交）" : "最终 payload"}
            value={isEditingPayload ? editedFinalPayload : approval.final_payload}
            note="审批通过后以后端收到的最终 payload 为准。"
          />
        </section>

        <section className="rounded-xl border border-[var(--aime-border)] p-4">
          <h3 className="text-sm font-semibold">AI 分析摘要</h3>
          <p className="mt-2 text-sm leading-6 text-[var(--aime-text-secondary)]">
            {approval.ai_reasoning_summary || "暂无分析摘要。"}
          </p>
        </section>
      </div>

      <div className="sticky bottom-0 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--aime-border)] bg-[var(--aime-surface)] p-4">
        <p className="text-xs text-[var(--aime-text-tertiary)]">
          {canExecuteAction
            ? "所有操作都会记录操作者、时间、原始 payload 和最终 payload。"
            : "当前动作已进入审批链路，执行器会在 Phase 2 接入。"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={!canTransition || busy} onClick={reject}>
            <XCircle className="size-3.5 text-[var(--aime-danger)]" />
            驳回
          </Button>
          <Button type="button" variant="outline" disabled={!canTransition || busy} onClick={takeOver}>
            <Hand className="size-3.5" />
            接管
          </Button>
          <Button type="button" variant="outline" disabled={approval.status !== "pending" || busy} onClick={observe}>
            <Eye className="size-3.5" />
            继续观察
          </Button>
          {canTransition && isEditableApproval(approval) && !isEditingPayload && (
            <Button type="button" variant="outline" disabled={busy || awaitingTaskResult} onClick={() => setIsEditingPayload(true)}>
              编辑后批准
            </Button>
          )}
          {isEditingPayload && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditedPayloadText(currentEditableText);
                setIsEditingPayload(false);
              }}
            >
              取消编辑
            </Button>
          )}
          <Button
            type="button"
            disabled={!canApprove || busy || (isEditingPayload && !editedPayloadText.trim())}
            onClick={() => approve(isEditingPayload)}
            className="bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
          >
            {approveApproval.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
            {isEditingPayload ? "保存并批准" : primaryActionLabel(approval.action_type)}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ApprovalSourceTrace({ approval }: { approval: AIApproval }) {
  const wsPaths = useWorkspacePaths();
  const channel = getApprovalPayloadText(approval, ["channel"]);
  const messageId = getApprovalPayloadText(approval, ["message_id"]);
  const outboundText = getApprovalPayloadText(approval, ["text", "reply_draft", "content"]);
  const isExternal =
    approval.action_type === "send_external_message" ||
    approval.action_type === "draft_reply";

  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">来源追踪</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            审批前先确认原始来源、目标渠道和即将代表你执行的内容。
          </p>
        </div>
        {isExternal && (
          <span className="rounded-md bg-[var(--aime-warning-bg)] px-2 py-1 text-xs font-medium text-[var(--aime-warning)]">
            对外动作
          </span>
        )}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <InfoCell label="来源类型" value={sourceLabel(approval.source_type)} />
        <InfoCell label="来源 ID" value={approval.source_ref_id || "未记录"} />
        <InfoCell label="关联 Issue" value={approval.issue_id || "无"} />
        <InfoCell label="收件箱记录">
          {approval.inbox_item_id ? (
            <AppLink
              href={wsPaths.inbox({ inboxItemId: approval.inbox_item_id })}
              className="truncate text-[var(--aime-brand-600)] hover:underline"
            >
              {approval.inbox_item_id}
            </AppLink>
          ) : (
            "无"
          )}
        </InfoCell>
        <InfoCell label="目标渠道" value={channel || sourceLabel(approval.source_type)} />
        <InfoCell label="消息 ID" value={messageId || "未记录"} />
      </div>
      {approval.source_url && (
        <a
          className="mt-3 inline-flex text-xs font-medium text-[var(--aime-brand-600)] hover:underline"
          href={approval.source_url}
          target="_blank"
          rel="noreferrer"
        >
          打开原始来源
        </a>
      )}
      {outboundText && (
        <div className="mt-3 rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
          <p className="text-xs font-medium text-[var(--aime-text-tertiary)]">
            待发送/保存内容
          </p>
          <p className="mt-1 line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-[var(--aime-text-secondary)]">
            {outboundText}
          </p>
        </div>
      )}
    </section>
  );
}

function ApprovalFailureNotice({ approval }: { approval: AIApproval }) {
  if (approval.execution_status !== "failed") return null;

  return (
    <section className="rounded-xl border border-[var(--aime-danger-bg)] bg-[var(--aime-danger-bg)] p-4 text-[var(--aime-danger)]">
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div>
          <h3 className="text-sm font-semibold">执行失败</h3>
          <p className="mt-1 text-sm leading-6">
            {approval.execution_error || "后端未返回失败原因。"}
          </p>
        </div>
      </div>
    </section>
  );
}

function ApprovalExecutionPanel({ approval }: { approval: AIApproval }) {
  const queryClient = useQueryClient();
  const { getAgentName } = useActorName();
  const [retrying, setRetrying] = useState(false);
  const retryApprovalExecution = useRetryAIApprovalExecution();
  const issueId = approval.created_issue_id ?? approval.issue_id;
  const shouldTrackTask =
    approval.action_type === "create_issue" ||
    approval.action_type === "assign_worker" ||
    !!approval.created_task_id;
  const shouldShow =
    shouldTrackTask ||
    approval.status === "approved" ||
    approval.execution_status === "failed" ||
    approval.execution_status === "succeeded";
  const shouldFetchTasks = !!issueId && shouldTrackTask && approval.status === "approved";

  const tasksQuery = useQuery({
    queryKey: issueKeys.tasks(issueId ?? approval.id),
    queryFn: () => api.listTasksByIssue(issueId!),
    enabled: shouldFetchTasks,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  if (!shouldShow) return null;

  const tasks = tasksQuery.data ?? [];
  const createdTask = approval.created_task_id
    ? tasks.find((task) => task.id === approval.created_task_id) ?? null
    : null;
  const canRetry = !!issueId && (createdTask?.status === "failed" || createdTask?.status === "cancelled");
  const canRetryApprovalExecution =
    approval.status === "approved" && approval.execution_status === "failed";

  const retryTask = async () => {
    if (!issueId || retrying) return;
    setRetrying(true);
    try {
      await api.rerunIssue(issueId);
      await queryClient.invalidateQueries({ queryKey: issueKeys.tasks(issueId) });
      toast.success("已重新派工，请在 Issue 执行日志查看新任务。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新派工失败");
    } finally {
      setRetrying(false);
    }
  };

  const retryExecution = async () => {
    if (!canRetryApprovalExecution) return;
    try {
      await retryApprovalExecution.mutateAsync({ id: approval.id });
      toast.success("已重新执行审批动作");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重试执行失败");
    }
  };

  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">执行结果</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            审批通过后，AI-Me 会把真实执行状态、产物 ID 和失败原因写回这里。
          </p>
        </div>
        {createdTask ? <TaskStatusBadge status={createdTask.status} /> : <ExecutionBadge status={approval.execution_status} />}
      </div>

      {approval.status !== "approved" ? (
        <div className="mt-3 rounded-lg border border-dashed border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
          当前审批尚未通过。批准后会记录执行状态、产物 ID 和失败原因。
        </div>
      ) : approval.execution_status === "failed" ? (
        <div className="mt-3 rounded-lg border border-[var(--aime-danger-bg)] bg-[var(--aime-danger-bg)] px-3 py-3 text-sm leading-6 text-[var(--aime-danger)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>审批动作执行失败：{approval.execution_error || "后端未返回失败原因。"}</span>
            {canRetryApprovalExecution && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={retryApprovalExecution.isPending}
                onClick={retryExecution}
                className="border-[var(--aime-danger)] bg-[var(--aime-surface)] text-[var(--aime-danger)] hover:bg-[var(--aime-surface)]"
              >
                {retryApprovalExecution.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                重试执行
              </Button>
            )}
          </div>
        </div>
      ) : approval.created_comment_id ? (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <InfoCell label="执行动作" value={actionLabel(approval.action_type)} />
          <InfoCell label="评论 ID" value={approval.created_comment_id} />
          <InfoCell label="关联工作项" value={approval.issue_id || "未记录"} />
        </div>
      ) : approval.action_type === "send_external_message" && approval.execution_status === "succeeded" ? (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <InfoCell label="执行动作" value={actionLabel(approval.action_type)} />
          <InfoCell label="目标渠道" value={getApprovalPayloadText(approval, ["channel", "provider"]) || sourceLabel(approval.source_type)} />
          <InfoCell label="消息 ID" value={getApprovalPayloadText(approval, ["message_id", "feishu_message_id", "source_message_id"]) || approval.source_ref_id || "未记录"} />
        </div>
      ) : !approval.created_task_id ? (
        <div className="mt-3 rounded-lg border border-dashed border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
          这次审批没有创建员工任务，可能是无需派工或动作被跳过。
        </div>
      ) : tasksQuery.isLoading ? (
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      ) : tasksQuery.error ? (
        <div className="mt-3 rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
          任务状态加载失败：{tasksQuery.error instanceof Error ? tasksQuery.error.message : "请稍后重试"}
        </div>
      ) : !createdTask ? (
        <div className="mt-3 rounded-lg border border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] px-3 py-3 text-sm leading-6 text-[var(--aime-warning)]">
          已记录任务 ID，但 Issue 执行日志中暂时没有找到对应任务。请刷新或查看后台日志。
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <InfoCell label="员工" value={getAgentName(createdTask.agent_id) || createdTask.agent_id} />
            <InfoCell label="任务状态" value={taskStatusLabel(createdTask.status)} />
            <InfoCell label="创建时间" value={formatDateTime(createdTask.created_at)} />
            <InfoCell label="完成时间" value={createdTask.completed_at ? formatDateTime(createdTask.completed_at) : "尚未完成"} />
          </div>
          <div className="rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-xs text-[var(--aime-text-tertiary)]">
                Task {createdTask.id}
              </p>
              {canRetry && (
                <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={retryTask}>
                  {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  重新派工
                </Button>
              )}
            </div>
            {createdTask.status === "failed" && (
              <p className="mt-2 text-sm leading-6 text-[var(--aime-danger)]">
                失败原因：{createdTask.error || taskFailureReasonLabel(createdTask.failure_reason) || "未知错误"}
              </p>
            )}
            {createdTask.status !== "failed" && createdTask.trigger_summary && (
              <p className="mt-2 text-sm leading-6 text-[var(--aime-text-secondary)]">
                任务说明：{createdTask.trigger_summary}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ApprovalRiskPanel({ approval, loading }: { approval: AIApproval | null; loading: boolean }) {
  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)] xl:flex">
      <div className="shrink-0 border-b border-[var(--aime-border)] p-4">
        <h2 className="text-sm font-semibold">风险与证据</h2>
      </div>
      {!approval ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <ShieldCheck className="size-9 text-[var(--aime-text-tertiary)]" />
          <p className="mt-3 text-sm font-medium">选择审批事项</p>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            这里会展示风险来源、关联证据和审批事件。
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--aime-text-tertiary)]">综合风险</span>
              <RiskBadge risk={approval.risk_level} />
            </div>
            <RiskMeter risk={approval.risk_level} />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <InfoCell label="可回滚性" value={reversibilityLabel(approval.reversibility)} />
              <InfoCell label="置信度" value={`${Math.round(approval.confidence * 100)}%`} />
            </div>
          </section>

          <ApprovalQualityReview approval={approval} />

          <section>
            <h3 className="text-sm font-semibold">关联证据</h3>
            <div className="mt-3 space-y-2">
              {loading ? (
                <>
                  <Skeleton className="h-20 rounded-xl" />
                  <Skeleton className="h-20 rounded-xl" />
                </>
              ) : (approval.evidence ?? []).length > 0 ? (
                (approval.evidence ?? []).map((item) => (
                  <div key={item.id} className="rounded-xl border border-[var(--aime-border)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium">{item.label}</p>
                      <span className="shrink-0 rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                        {evidenceLabel(item.evidence_type)}
                      </span>
                    </div>
                    {item.quote && (
                      <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--aime-text-tertiary)]">
                        {item.quote}
                      </p>
                    )}
                    <div className="mt-2 space-y-1 text-[11px] leading-5 text-[var(--aime-text-tertiary)]">
                      {item.ref_id && <p className="truncate">Ref: {item.ref_id}</p>}
                      {item.source_url && (
                        <a
                          className="inline-flex font-medium text-[var(--aime-brand-600)] hover:underline"
                          href={item.source_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开证据来源
                        </a>
                      )}
                      {metadataSummary(item.metadata) && (
                        <p className="line-clamp-2">{metadataSummary(item.metadata)}</p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
                  暂无证据条目。
                </p>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold">审批事件</h3>
            <div className="mt-3 space-y-2">
              {loading ? (
                <>
                  <Skeleton className="h-16 rounded-xl" />
                  <Skeleton className="h-16 rounded-xl" />
                </>
              ) : (approval.events ?? []).length > 0 ? (
                (approval.events ?? []).map((event) => (
                  <div key={event.id} className="flex gap-3 rounded-xl border border-[var(--aime-border)] p-3">
                    <Clock3 className="mt-0.5 size-3.5 shrink-0 text-[var(--aime-text-tertiary)]" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{eventLabel(event.event_type, event.payload)}</p>
                      <p className="mt-1 text-xs text-[var(--aime-text-tertiary)]">
                        {formatRelative(event.created_at)}
                        {event.from_status && event.to_status
                          ? ` · ${statusLabel(event.from_status)} → ${statusLabel(event.to_status)}`
                          : ""}
                      </p>
                      {eventPayloadSummary(event.payload) && (
                        <p className="mt-1 line-clamp-3 text-xs leading-5 text-[var(--aime-text-tertiary)]">
                          {eventPayloadSummary(event.payload)}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
                  暂无事件记录。
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}

function ApprovalQualityReview({ approval }: { approval: AIApproval }) {
  const rateApproval = useRateAIApproval();
  const [score, setScore] = useState(approvalQualityScore(approval) || 0);
  const [note, setNote] = useState("");
  const canSubmit = score >= 1 && score <= 5 && !rateApproval.isPending;

  useEffect(() => {
    setScore(approvalQualityScore(approval) || 0);
    setNote("");
  }, [approval]);

  const submit = async () => {
    if (!canSubmit) return;
    try {
      await rateApproval.mutateAsync({
        id: approval.id,
        data: {
          score,
          note: note.trim(),
          outcome: approval.execution_status === "succeeded" ? "accepted" : approval.execution_status,
        },
      });
      toast.success("质量复盘已记录");
      setNote("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "记录复盘失败");
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">质量复盘</h3>
        {approvalQualityScore(approval) > 0 && (
          <span className="rounded-full bg-[var(--aime-success-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--aime-success)]">
            已评分 {approvalQualityScore(approval)}/5
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setScore(value)}
            className={cn(
              "flex size-7 items-center justify-center rounded-lg border text-xs font-semibold transition-colors",
              score === value
                ? "border-[var(--aime-brand-200)] bg-[var(--aime-brand-50)] text-[var(--aime-brand-700)]"
                : "border-[var(--aime-border)] text-[var(--aime-text-tertiary)] hover:bg-[var(--aime-surface-muted)]",
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <Textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="记录这次判断哪里好、哪里需要改..."
        className="mt-3 min-h-20 resize-none rounded-xl border-[var(--aime-border)] text-sm"
      />
      <Button
        type="button"
        size="sm"
        className="mt-3 border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
        disabled={!canSubmit}
        onClick={submit}
      >
        {rateApproval.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardCheck className="size-3.5" />}
        记录评分
      </Button>
    </section>
  );
}

function PayloadBlock({ title, value, note }: { title: string; value: unknown; note?: string }) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] p-3 font-mono text-xs leading-5 text-[var(--aime-text-secondary)]">
        {formatJSON(value)}
      </pre>
      {note && (
        <p className="mt-2 text-xs text-[var(--aime-text-tertiary)]">
          {note}
        </p>
      )}
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
  value: number;
  hint: string;
  tone: "brand" | "success" | "warning" | "danger";
}) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <p className={cn("text-xs font-medium", toneTextClass(tone))}>{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="font-mono text-2xl font-semibold leading-none tabular-nums">{value}</p>
        <p className="text-right text-xs text-[var(--aime-text-tertiary)]">{hint}</p>
      </div>
    </div>
  );
}

function StatusMetric({ label, value, tone }: { label: string; value: number; tone: "brand" | "danger" }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-[var(--aime-border)] bg-[var(--aime-surface)] px-3 py-1.5 text-xs font-medium">
      <span className={toneTextClass(tone)}>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

function InfoCell({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--aime-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--aime-text-tertiary)]">{label}</p>
      <p className="mt-1 truncate text-xs font-semibold">{children ?? value}</p>
    </div>
  );
}

function QueueEmpty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <ShieldCheck className="size-9 text-[var(--aime-text-tertiary)]" />
      <h3 className="mt-3 text-sm font-semibold">暂无待审批事项</h3>
      <p className="mt-1 text-sm leading-6 text-[var(--aime-text-tertiary)]">
        只有真正需要你确认的动作才会进入队列。
      </p>
    </div>
  );
}

function ErrorBlock({ error }: { error: unknown }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <AlertCircle className="size-8 text-[var(--aime-danger)]" />
      <p className="text-sm font-medium">加载审批失败</p>
      <p className="max-w-md text-xs leading-5 text-[var(--aime-text-tertiary)]">
        {error instanceof Error ? error.message : "请稍后重试"}
      </p>
    </div>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const label = risk === "high" ? "高风险" : risk === "low" ? "低风险" : "中风险";
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
      risk === "high" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
      risk === "medium" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
      risk === "low" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
    )}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
      status === "pending" && "bg-[var(--aime-brand-50)] text-[var(--aime-brand-700)]",
      status === "approved" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      status === "rejected" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
      status === "observing" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
      status === "taken_over" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
      status === "expired" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
    )}>
      {statusLabel(status)}
    </span>
  );
}

function ExecutionBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
      status === "succeeded" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      status === "failed" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
      status === "running" && "bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
      (status === "not_started" || status === "skipped") && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
    )}>
      {executionLabel(status)}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: AgentTask["status"] }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
      (status === "queued" || status === "dispatched") && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
      status === "running" && "bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
      status === "completed" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      status === "failed" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
      status === "cancelled" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
    )}>
      {taskStatusLabel(status)}
    </span>
  );
}

function RiskMeter({ risk }: { risk: string }) {
  const width = risk === "high" ? 92 : risk === "medium" ? 62 : 32;
  return (
    <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--aime-surface-muted)]">
      <div
        className={cn(
          "h-full rounded-full",
          risk === "high" && "bg-[var(--aime-danger)]",
          risk === "medium" && "bg-[var(--aime-warning)]",
          risk === "low" && "bg-[var(--aime-success)]",
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function applyClientFilter(approvals: AIApproval[], filter: ApprovalFilterKey) {
  if (filter === "external") {
    return approvals.filter(
      (approval) =>
        approval.action_type === "draft_reply" ||
        approval.action_type === "send_external_message",
    );
  }
  if (filter === "failed") {
    return approvals.filter((approval) => approval.execution_status === "failed");
  }
  return approvals;
}

function actionIcon(actionType: string) {
  if (actionType === "post_internal_comment") return <MessageSquare className="size-4" />;
  if (actionType === "send_external_message") return <MessageSquare className="size-4" />;
  if (actionType === "draft_reply") return <FileText className="size-4" />;
  return <ShieldCheck className="size-4" />;
}

function actionLabel(actionType: string) {
  switch (actionType as AIApprovalActionType) {
    case "create_issue":
      return "创建 issue";
    case "assign_worker":
      return "分配员工";
    case "draft_reply":
      return "保存回复草稿";
    case "send_external_message":
      return "发送外部消息";
    case "post_internal_comment":
      return "发布内部评论";
    case "confirm_memory":
      return "确认记忆";
    case "no_action":
      return "无需动作";
    default:
      return actionType;
  }
}

function sourceLabel(sourceType: string) {
  switch (sourceType) {
    case "ai_me_think":
      return "AI-Me 判断";
    case "exception":
      return "例外";
    case "inbox":
      return "收件箱";
    case "issue":
      return "issue";
    case "comment":
      return "评论";
    case "agent_task":
      return "员工 task";
    case "memory":
      return "记忆";
    case "feishu":
      return "飞书";
    case "email":
      return "邮件";
    case "github":
      return "GitHub";
    case "manual":
      return "手动";
    default:
      return sourceType || "未知来源";
  }
}

function statusLabel(status: string) {
  switch (status as AIApprovalStatus) {
    case "pending":
      return "待审批";
    case "approved":
      return "已批准";
    case "rejected":
      return "已驳回";
    case "observing":
      return "继续观察";
    case "taken_over":
      return "已接管";
    case "expired":
      return "已过期";
    default:
      return status;
  }
}

function executionLabel(status: string) {
  switch (status) {
    case "not_started":
      return "未执行";
    case "running":
      return "执行中";
    case "succeeded":
      return "已成功";
    case "failed":
      return "失败";
    case "skipped":
      return "已跳过";
    default:
      return status;
  }
}

function taskStatusLabel(status: AgentTask["status"]) {
  switch (status) {
    case "queued":
      return "已排队";
    case "dispatched":
      return "已领取";
    case "running":
      return "执行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function taskFailureReasonLabel(reason: AgentTask["failure_reason"] | undefined) {
  switch (reason) {
    case "agent_error":
      return "员工执行错误";
    case "timeout":
      return "执行超时";
    case "runtime_offline":
      return "Runtime 离线";
    case "runtime_recovery":
      return "Runtime 恢复时发现任务中断";
    case "manual":
      return "人工取消或失败";
    default:
      return "";
  }
}

function reversibilityLabel(value: string) {
  switch (value) {
    case "reversible":
      return "可回滚";
    case "partially_reversible":
      return "部分可回滚";
    case "irreversible":
      return "不可逆";
    default:
      return value;
  }
}

function evidenceLabel(value: string) {
  switch (value) {
    case "user_input":
      return "用户输入";
    case "agent_task":
      return "员工 task";
    default:
      return sourceLabel(value);
  }
}

function eventLabel(value: string, payload?: unknown) {
  const kind = isRecord(payload) ? metadataString(payload.kind) : "";
  if (kind === "task_result_waiting") return "等待员工结果";
  if (kind === "task_result_ready") return "员工结果已复核";
  if (kind === "task_result_review_failed") return "员工结果复核失败";
  if (kind === "task_result_tool_completed") return "后续工具已完成";
  if (kind === "task_result_tool_stopped") return "后续工具已停止";
  switch (value) {
    case "created":
      return "创建审批";
    case "edited":
      return "编辑审批";
    case "approved":
      return "批准";
    case "rejected":
      return "驳回";
    case "observing":
      return "继续观察";
    case "taken_over":
      return "接管";
    case "execution_succeeded":
      return "执行成功";
    case "execution_failed":
      return "执行失败";
    default:
      return value;
  }
}

function primaryActionLabel(actionType: string) {
  switch (actionType) {
    case "post_internal_comment":
      return "批准并评论";
    case "send_external_message":
      return "批准并发送";
    case "draft_reply":
      return "保存草稿";
    case "no_action":
      return "批准记录";
    case "create_issue":
      return "批准并创建 issue";
    case "assign_worker":
      return "批准并分配员工";
    case "confirm_memory":
      return "确认记忆";
    default:
      return "批准";
  }
}

function toneTextClass(tone: "brand" | "success" | "warning" | "danger") {
  switch (tone) {
    case "brand":
      return "text-[var(--aime-brand-600)]";
    case "success":
      return "text-[var(--aime-success)]";
    case "warning":
      return "text-[var(--aime-warning)]";
    case "danger":
      return "text-[var(--aime-danger)]";
  }
}

function formatJSON(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function isEditableApproval(approval: AIApproval) {
  return EDITABLE_APPROVAL_ACTION_TYPES.has(approval.action_type);
}

function approvalAwaitsTaskResult(approval: AIApproval) {
  const payload = getPayloadRecord(approval.final_payload);
  return payload?.awaiting_task_result === true;
}

function getEditableApprovalText(approval: AIApproval) {
  return getApprovalPayloadText(approval, EDITABLE_PAYLOAD_TEXT_KEYS);
}

function getEditableApprovalPayloadKey(approval: AIApproval) {
  for (const payload of [approval.final_payload, approval.original_payload]) {
    if (!isRecord(payload)) continue;
    for (const key of EDITABLE_PAYLOAD_TEXT_KEYS) {
      if (typeof payload[key] === "string") return key;
    }
  }
  if (approval.action_type === "post_internal_comment") return "content";
  if (approval.action_type === "draft_reply") return "reply_draft";
  return "text";
}

function buildEditedApprovalPayload(approval: AIApproval, text: string) {
  const base = getPayloadRecord(approval.final_payload) ?? getPayloadRecord(approval.original_payload) ?? {};
  return {
    ...base,
    [getEditableApprovalPayloadKey(approval)]: text,
  };
}

function getPayloadRecord(value: unknown) {
  if (!isRecord(value)) return null;
  return value;
}

function getApprovalPayloadText(approval: AIApproval, keys: string[]) {
  for (const payload of [approval.final_payload, approval.original_payload]) {
    if (!isRecord(payload)) continue;
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" || typeof value === "boolean") return String(value);
    }
  }
  return "";
}

function metadataSummary(value: unknown) {
  if (!isRecord(value)) return "";
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && entryValue !== "")
    .slice(0, 2);
  if (entries.length === 0) return "";
  return entries
    .map(([key, entryValue]) => `${key}: ${metadataValueLabel(entryValue)}`)
    .join(" · ");
}

function metadataValueLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function eventPayloadSummary(value: unknown) {
  if (!isRecord(value)) return "";
  const parts: string[] = [];
  const kind = metadataString(value.kind);
  const score = metadataString(value.score);
  const note = metadataString(value.note);
  const outcome = metadataString(value.outcome);
  const status = metadataString(value.execution_status);
  const error = metadataString(value.execution_error) || metadataString(value.error);
  const taskId = metadataString(value.created_task_id) || metadataString(value.task_id);
  const taskStatus = metadataString(value.task_status);
  const toolStatus = metadataString(value.tool_status);
  const issueId = metadataString(value.issue_id);
  const continuationDepth = metadataString(value.continuation_depth);
  const commentId = metadataString(value.created_comment_id);
  const messageId = metadataString(value.message_id);
  const channel = metadataString(value.channel);
  if (kind === "quality_review") parts.push(`评分：${score || "-"} / 5`);
  if (kind === "quality_review" && outcome) parts.push(`结果：${outcome}`);
  if (kind === "quality_review" && note) parts.push(`备注：${note}`);
  if (status) parts.push(`状态：${executionLabel(status)}`);
  if (taskId) parts.push(`任务：${taskId}`);
  if (taskStatus) parts.push(`任务状态：${taskStatusLabel(taskStatus as AgentTask["status"])}`);
  if (toolStatus) parts.push(`工具状态：${toolStatus}`);
  if (issueId) parts.push(`工作项：${issueId}`);
  if (continuationDepth) parts.push(`续跑：第 ${continuationDepth} 层`);
  if (commentId) parts.push(`评论：${commentId}`);
  if (channel) parts.push(`渠道：${channel}`);
  if (messageId) parts.push(`消息：${messageId}`);
  if (error) parts.push(`错误：${error}`);
  return parts.join(" · ");
}

function approvalQualityScore(approval: AIApproval) {
  const event = [...(approval.events ?? [])]
    .reverse()
    .find((item) => {
      if (!isRecord(item.payload)) return false;
      return item.payload.kind === "quality_review";
    });
  if (!event || !isRecord(event.payload)) return 0;
  const raw = event.payload.score;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function metadataString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRelative(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "未知";
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
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
