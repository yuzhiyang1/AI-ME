"use client";

import type { ReactNode } from "react";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useThinkAIMe } from "@multica/core/aime";
import { approvalKeys } from "@multica/core/approvals";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useModalStore } from "@multica/core/modals";
import { useIssueDraftStore } from "@multica/core/issues/stores/draft-store";
import {
  inboxListOptions,
  deduplicateInboxItems,
  useInboxUnreadCount,
} from "@multica/core/inbox/queries";
import {
  useMarkInboxRead,
  useArchiveInbox,
  useMarkAllInboxRead,
  useArchiveAllInbox,
  useArchiveAllReadInbox,
  useArchiveCompletedInbox,
} from "@multica/core/inbox/mutations";

import { IssueDetail } from "../../issues/components";
import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import { useNavigation } from "../../navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Inbox,
  CheckCheck,
  Archive,
  BookCheck,
  ListChecks,
  ArrowLeft,
  AlertCircle,
  BrainCircuit,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AIMeRiskLevel, AIMeThinkResponse, InboxItem } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@multica/ui/components/ui/resizable";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@multica/ui/components/ui/dropdown-menu";
import { useIsMobile } from "@multica/ui/hooks/use-mobile";
import { PageHeader } from "../../layout/page-header";
import { InboxListItem, useTimeAgo } from "./inbox-list-item";
import { useTypeLabels } from "./inbox-detail-label";
import {
  buildInboxAIMeInput,
  getInboxAIMeIntent,
  getInboxDisplayTitle,
} from "./inbox-display";
import { useT } from "../../i18n";

export function InboxPage() {
  const { t } = useT("inbox");
  const { searchParams, replace, push } = useNavigation();
  const urlIssue = searchParams.get("issue") ?? "";
  const wsPaths = useWorkspacePaths();
  const queryClient = useQueryClient();

  const [selectedKey, setSelectedKeyState] = useState(() => urlIssue);
  const [aiMeResultsByInboxId, setAIMeResultsByInboxId] = useState<
    Record<string, AIMeThinkResponse>
  >({});
  const [aiMeErrorsByInboxId, setAIMeErrorsByInboxId] = useState<Record<string, string>>({});
  const [aiMePendingInboxId, setAIMePendingInboxId] = useState<string | null>(null);

  // Sync from URL when searchParams change (e.g. navigation)
  useEffect(() => {
    setSelectedKeyState(urlIssue);
  }, [urlIssue]);

  const wsId = useWorkspaceId();
  const { data: rawItems = [], isLoading: loading } = useQuery(inboxListOptions(wsId));
  const items = useMemo(() => deduplicateInboxItems(rawItems), [rawItems]);

  const selected = items.find((i) => (i.issue_id ?? i.id) === selectedKey) ?? null;

  // Track the last key we actually resolved against the inbox list. Lets the
  // fallback effect distinguish "shared-link to a notification not in our
  // inbox" (never resolved → redirect to the issue page) from "item was in
  // our inbox and just got removed" (was resolved → stay on /inbox).
  const lastResolvedKeyRef = useRef<string>("");
  useEffect(() => {
    if (selected) lastResolvedKeyRef.current = selectedKey;
  }, [selected, selectedKey]);

  const setSelectedKey = useCallback((key: string) => {
    setSelectedKeyState(key);
    const inboxPath = wsPaths.inbox();
    const url = key ? `${inboxPath}?issue=${key}` : inboxPath;
    replace(url);
  }, [replace, wsPaths]);

  // Shared inbox links (?issue=<id>) may point to notifications not in this
  // user's inbox (archived, or never received). Fall back to the issue page
  // so the URL still resolves to something meaningful. But if the key was
  // previously resolvable (e.g. the issue was just deleted in another tab
  // and `onInboxIssueDeleted` pruned the cache), the issue detail would 404
  // too — clear the selection and stay on /inbox instead.
  useEffect(() => {
    if (loading) return;
    if (!selectedKey) return;
    if (selected) return;
    if (lastResolvedKeyRef.current === selectedKey) {
      setSelectedKey("");
      return;
    }
    replace(wsPaths.issueDetail(selectedKey));
  }, [loading, selectedKey, selected, replace, wsPaths, setSelectedKey]);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "multica_inbox_layout",
  });

  const isMobile = useIsMobile();
  const unreadCount = useInboxUnreadCount(wsId);

  const markReadMutation = useMarkInboxRead();
  const archiveMutation = useArchiveInbox();
  const markAllReadMutation = useMarkAllInboxRead();
  const archiveAllMutation = useArchiveAllInbox();
  const archiveAllReadMutation = useArchiveAllReadInbox();
  const archiveCompletedMutation = useArchiveCompletedInbox();
  const thinkAIMe = useThinkAIMe();
  const timeAgo = useTimeAgo();
  const typeLabels = useTypeLabels();


  // Auto-mark-read whenever a selected item is unread — covers both click-
  // to-select and URL-param-select (e.g. OS notification click on desktop).
  // The mutation flips `read: true` optimistically, so this effect settles
  // in one pass and can't loop. Kept in a `useEffect` rather than inlined
  // in handleSelect so URL-driven selection triggers it too.
  const markReadMutate = markReadMutation.mutate;
  const selectedId = selected?.id;
  const selectedRead = selected?.read;
  useEffect(() => {
    if (!selectedId || selectedRead) return;
    markReadMutate(selectedId, {
      onError: () => toast.error(t(($) => $.errors.mark_read_failed)),
    });
  }, [selectedId, selectedRead, markReadMutate, t]);

  const handleSelect = (item: InboxItem) => {
    setSelectedKey(item.issue_id ?? item.id);
  };

  const handleArchive = (id: string) => {
    const idx = items.findIndex((i) => i.id === id);
    const archived = idx >= 0 ? items[idx] : null;
    const wasSelected =
      !!archived && (archived.issue_id ?? archived.id) === selectedKey;
    if (wasSelected) {
      // List is sorted newest-first; prefer the next (older) item, fall back
      // to the previous (newer) one when archiving at the bottom, and only
      // clear the selection when nothing else is left.
      const next = items[idx + 1] ?? items[idx - 1] ?? null;
      setSelectedKey(next ? (next.issue_id ?? next.id) : "");
    }
    archiveMutation.mutate(id, {
      onError: () => toast.error(t(($) => $.errors.archive_failed)),
    });
  };

  // Batch operations
  const handleMarkAllRead = () => {
    markAllReadMutation.mutate(undefined, {
      onError: () => toast.error(t(($) => $.errors.mark_all_read_failed)),
    });
  };

  const handleArchiveAll = () => {
    setSelectedKey("");
    archiveAllMutation.mutate(undefined, {
      onError: () => toast.error(t(($) => $.errors.archive_all_failed)),
    });
  };

  const handleArchiveAllRead = () => {
    const readKeys = items.filter((i) => i.read).map((i) => i.issue_id ?? i.id);
    if (readKeys.includes(selectedKey)) setSelectedKey("");
    archiveAllReadMutation.mutate(undefined, {
      onError: () => toast.error(t(($) => $.errors.archive_all_read_failed)),
    });
  };

  const handleArchiveCompleted = () => {
    setSelectedKey("");
    archiveCompletedMutation.mutate(undefined, {
      onError: () => toast.error(t(($) => $.errors.archive_completed_failed)),
    });
  };

  const handleAIMeJudge = useCallback(async (item: InboxItem) => {
    const title = getInboxDisplayTitle(item);
    const typeLabel = typeLabels[item.type] ?? item.type;
    setAIMePendingInboxId(item.id);
    setAIMeErrorsByInboxId((current) => ({ ...current, [item.id]: "" }));
    try {
      const result = await thinkAIMe.mutateAsync({
        input: buildInboxAIMeInput(item, { title, typeLabel }),
        intent: getInboxAIMeIntent(item),
        source_type: "inbox",
        source_ref_id: item.id,
        issue_id: item.issue_id ?? undefined,
        need_worker_plan: true,
      });
      setAIMeResultsByInboxId((current) => ({ ...current, [item.id]: result }));
      if (result.approval_id || (result.approval_ids?.length ?? 0) > 0) {
        await queryClient.invalidateQueries({ queryKey: approvalKeys.all(wsId) });
        toast.success("AI-Me 已生成审批事项");
      } else if (result.configuration_required) {
        toast.warning("AI-Me 模型尚未配置，已展示兜底判断");
      } else {
        toast.success("AI-Me 已完成判断");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI-Me 判断失败";
      setAIMeErrorsByInboxId((current) => ({ ...current, [item.id]: message }));
      toast.error(message);
    } finally {
      setAIMePendingInboxId(null);
    }
  }, [queryClient, thinkAIMe, typeLabels, wsId]);

  const openApprovalCenter = useCallback((approvalId?: string) => {
    push(wsPaths.approvals(approvalId));
  }, [push, wsPaths]);

  // -- Shared sub-components --------------------------------------------------

  const listHeader = (
    <PageHeader className="justify-between">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
        {unreadCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {unreadCount}
          </span>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuItem onClick={handleMarkAllRead}>
            <CheckCheck className="h-4 w-4" />
            {t(($) => $.menu.mark_all_read)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleArchiveAll}>
            <Archive className="h-4 w-4" />
            {t(($) => $.menu.archive_all)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleArchiveAllRead}>
            <BookCheck className="h-4 w-4" />
            {t(($) => $.menu.archive_all_read)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleArchiveCompleted}>
            <ListChecks className="h-4 w-4" />
            {t(($) => $.menu.archive_completed)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PageHeader>
  );

  const listBody = items.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Inbox className="mb-3 h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm">{t(($) => $.list.empty)}</p>
    </div>
  ) : (
    <div>
      {items.map((item) => (
        <InboxListItem
          key={item.id}
          item={item}
          isSelected={(item.issue_id ?? item.id) === selectedKey}
          onClick={() => handleSelect(item)}
          onArchive={() => handleArchive(item.id)}
        />
      ))}
    </div>
  );

  const selectedAIMePanel = selected ? (
    <AIMeInboxActionPanel
      item={selected}
      typeLabel={typeLabels[selected.type] ?? selected.type}
      result={aiMeResultsByInboxId[selected.id] ?? null}
      error={aiMeErrorsByInboxId[selected.id] ?? ""}
      isPending={aiMePendingInboxId === selected.id}
      onRun={() => handleAIMeJudge(selected)}
      onOpenApprovalCenter={openApprovalCenter}
    />
  ) : null;

  const detailContent = selected?.issue_id ? (
    // Key by issue_id (not inbox-item id): a new comment/reaction generates a
    // new inbox notification for the same issue, and the dedup helper picks the
    // newest one — keying on its id would remount IssueDetail on every event,
    // wiping the comment composer draft and resetting scroll position.
    <ErrorBoundary resetKeys={[selected.issue_id]}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b bg-background/60 p-4">
          {selectedAIMePanel}
        </div>
        <div className="min-h-0 flex-1">
          <IssueDetail
            key={selected.issue_id}
            issueId={selected.issue_id}
            defaultSidebarOpen={false}
            layoutId="multica_inbox_issue_detail_layout"
            highlightCommentId={selected.details?.comment_id ?? undefined}
            onDelete={() => {
              // Issue deletion CASCADE-deletes the inbox item server-side, and the
              // issue:deleted WS event prunes it from the inbox cache. Just clear
              // the selection — calling archive here would 404 on a row that no
              // longer exists.
              setSelectedKey("");
            }}
            onDone={() => {
              handleArchive(selected.id);
            }}
          />
        </div>
      </div>
    </ErrorBoundary>
  ) : selected ? (
    <div className="p-6">
      <h2 className="text-lg font-semibold">{getInboxDisplayTitle(selected)}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {typeLabels[selected.type]} · {timeAgo(selected.created_at)}
      </p>
      {selected.body && (
        <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
          {selected.body}
        </div>
      )}
      {selected.type === "quick_create_failed" && selected.details?.original_prompt && (
        <div className="mt-4 rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t(($) => $.detail.original_input)}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{selected.details.original_prompt}</p>
        </div>
      )}
      <div className="mt-4">
        {selectedAIMePanel}
      </div>
      <div className="mt-4 flex gap-2">
        {selected.type === "quick_create_failed" && (
          <Button
            size="sm"
            onClick={() => {
              // Seed the legacy advanced form with the original prompt so the
              // user can recover their input in the full editor instead of
              // retyping. The agent picker hint becomes the assignee
              // candidate (still editable).
              const prompt = selected.details?.original_prompt ?? "";
              const agentId = selected.details?.agent_id;
              useIssueDraftStore.getState().setDraft({
                description: prompt,
                ...(agentId
                  ? { assigneeType: "agent" as const, assigneeId: agentId }
                  : {}),
              });
              useModalStore.getState().open("create-issue");
            }}
          >
            {t(($) => $.detail.edit_advanced)}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArchive(selected.id)}
        >
          <Archive className="mr-1.5 h-3.5 w-3.5" />
          {t(($) => $.detail.archive)}
        </Button>
      </div>
    </div>
  ) : null;

  // -- Mobile layout: list / detail toggle -----------------------------------

  if (isMobile) {
    if (loading) {
      return (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex h-12 shrink-0 items-center border-b px-4">
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1 p-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Mobile: show detail full-screen when an item is selected
    if (selected) {
      return (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex h-12 shrink-0 items-center border-b px-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedKey("")}
              className="gap-1.5 text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t(($) => $.page.back)}
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {detailContent}
          </div>
        </div>
      );
    }

    // Mobile: full-screen list
    return (
      <div className="flex flex-1 flex-col min-h-0">
        {listHeader}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {listBody}
        </div>
      </div>
    );
  }

  // -- Desktop layout: resizable two-panel -----------------------------------

  if (loading) {
    return (
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <ResizablePanel id="list" defaultSize={320} minSize={240} maxSize={480} groupResizeBehavior="preserve-pixel-size">
          <div className="flex flex-col border-r h-full">
            <div className="flex h-12 shrink-0 items-center border-b px-4">
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="detail" minSize="40%">
          <div className="p-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="mt-4 h-4 w-32" />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="list" defaultSize={320} minSize={240} maxSize={480} groupResizeBehavior="preserve-pixel-size">
      <div className="flex flex-col border-r h-full">
        {listHeader}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {listBody}
        </div>
      </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="detail" minSize="40%">
      <div className="flex flex-col min-h-0 h-full">
        {detailContent ?? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <Inbox className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm">
              {items.length === 0
                ? t(($) => $.detail.empty)
                : t(($) => $.detail.select_prompt)}
            </p>
          </div>
        )}
      </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function AIMeInboxActionPanel({
  item,
  typeLabel,
  result,
  error,
  isPending,
  onRun,
  onOpenApprovalCenter,
}: {
  item: InboxItem;
  typeLabel: string;
  result: AIMeThinkResponse | null;
  error: string;
  isPending: boolean;
  onRun: () => void;
  onOpenApprovalCenter: (approvalId?: string) => void;
}) {
  const approvalIds = getAIMeApprovalIds(result);
  const approvalCount = approvalIds.length;
  const primaryApprovalId = approvalIds[0];
  const actions = result?.actions ?? [];
  const evidence = result?.evidence ?? [];

  return (
    <section className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <BrainCircuit className="size-4 text-[var(--aime-brand-600)]" />
            <h3 className="text-sm font-semibold text-[var(--aime-text)]">
              AI-Me 例外判断
            </h3>
            <Badge variant="outline" className="border-[var(--aime-border)] text-[var(--aime-text-tertiary)]">
              {typeLabel}
            </Badge>
            {result && <AIMeRiskBadge risk={result.risk_level} />}
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            基于原始事件、关联 Issue、可用记忆和员工上下文生成建议；对外动作仍需审批。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          onClick={onRun}
          className="border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
        >
          {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          交给 AI-Me 判断
        </Button>
      </div>

      {error && (
        <div className="mt-3 flex gap-2 rounded-lg border border-[var(--aime-danger-bg)] bg-[var(--aime-danger-bg)] px-3 py-2 text-sm leading-6 text-[var(--aime-danger)]">
          <AlertCircle className="mt-1 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isPending && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      )}

      {result && !isPending && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <AIMeInboxInfoCell label="风险" value={riskLabel(result.risk_level)} />
            <AIMeInboxInfoCell label="置信度" value={`${Math.round(result.confidence * 100)}%`} />
            <AIMeInboxInfoCell
              label="审批状态"
              value={approvalCount > 0 ? `已生成 ${approvalCount} 条` : result.need_approval ? "需要审批" : "无需审批"}
            />
          </div>

          <div className="rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
            <p className="text-xs font-medium text-[var(--aime-text-tertiary)]">
              判断摘要 · {modeLabel(result.mode)}
            </p>
            <p className="mt-1 text-sm leading-6 text-[var(--aime-text-secondary)]">
              {result.summary || "AI-Me 暂未返回摘要。"}
            </p>
          </div>

          {result.configuration_required && (
            <div className="flex gap-2 rounded-lg bg-[var(--aime-warning-bg)] px-3 py-2 text-sm leading-6 text-[var(--aime-warning)]">
              <AlertCircle className="mt-1 size-3.5 shrink-0" />
              <span>当前模型未配置或不可用，这次结果来自兜底判断。</span>
            </div>
          )}

          {result.reply_draft && (
            <div className="rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
              <p className="text-xs font-medium text-[var(--aime-text-tertiary)]">回复草稿</p>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-[var(--aime-text-secondary)]">
                {result.reply_draft}
              </p>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <AIMeInboxMiniList
              icon={<ShieldCheck className="size-3.5 text-[var(--aime-brand-600)]" />}
              title="建议动作"
              emptyText="暂无建议动作。"
              items={actions.slice(0, 3).map((action) => ({
                title: action.title || action.type,
                description: action.description,
                meta: action.requires_approval ? "需要审批" : "可直接处理",
              }))}
            />
            <AIMeInboxMiniList
              icon={<ExternalLink className="size-3.5 text-[var(--aime-brand-600)]" />}
              title="关联证据"
              emptyText="暂无证据条目。"
              items={evidence.slice(0, 3).map((entry) => ({
                title: entry.label || entry.type,
                description: entry.quote,
                meta: entry.type,
              }))}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--aime-border)] pt-3">
            <p className="text-xs leading-5 text-[var(--aime-text-tertiary)]">
              来源：{getInboxDisplayTitle(item)}
            </p>
            {approvalCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenApprovalCenter(primaryApprovalId)}
              >
                <ExternalLink className="size-3.5" />
                去审批中心
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function getAIMeApprovalIds(result: AIMeThinkResponse | null) {
  const ids = [result?.approval_id, ...(result?.approval_ids ?? [])].filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  return Array.from(new Set(ids));
}

function AIMeInboxInfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
      <p className="text-xs text-[var(--aime-text-tertiary)]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[var(--aime-text)]">
        {value}
      </p>
    </div>
  );
}

function AIMeInboxMiniList({
  icon,
  title,
  emptyText,
  items,
}: {
  icon: ReactNode;
  title: string;
  emptyText: string;
  items: { title: string; description?: string; meta?: string }[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {icon}
        <h4 className="text-xs font-semibold text-[var(--aime-text)]">{title}</h4>
      </div>
      <div className="mt-2 space-y-2">
        {items.length === 0 ? (
          <p className="rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            {emptyText}
          </p>
        ) : (
          items.map((entry, index) => (
            <div key={`${entry.title}-${index}`} className="rounded-lg bg-[var(--aime-surface-subtle)] px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-medium text-[var(--aime-text)]">
                  {entry.title}
                </p>
                {entry.meta && (
                  <span className="shrink-0 text-xs text-[var(--aime-text-tertiary)]">
                    {entry.meta}
                  </span>
                )}
              </div>
              {entry.description && (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--aime-text-tertiary)]">
                  {entry.description}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AIMeRiskBadge({ risk }: { risk: AIMeRiskLevel | string }) {
  const className =
    risk === "high"
      ? "border-[var(--aime-danger-bg)] bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]"
      : risk === "medium"
        ? "border-[var(--aime-warning-bg)] bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]"
        : "border-[var(--aime-success-bg)] bg-[var(--aime-success-bg)] text-[var(--aime-success)]";

  return (
    <Badge variant="outline" className={className}>
      {riskLabel(risk)}
    </Badge>
  );
}

function riskLabel(risk: AIMeRiskLevel | string) {
  switch (risk) {
    case "high":
      return "高风险";
    case "medium":
      return "中风险";
    case "low":
      return "低风险";
    default:
      return "未知风险";
  }
}

function modeLabel(mode: string) {
  switch (mode) {
    case "llm":
      return "LLM";
    case "fallback":
      return "兜底判断";
    case "provider_error":
      return "模型异常";
    case "unconfigured":
      return "未配置";
    default:
      return mode || "未知模式";
  }
}
