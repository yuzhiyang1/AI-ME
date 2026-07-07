"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Archive,
  BookOpenText,
  Check,
  Database,
  FileText,
  Filter,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  knowledgeDocumentListOptions,
  memoryDetailOptions,
  memoryListOptions,
  useArchiveMemoryEntry,
  useConfirmMemoryEntry,
  useCreateKnowledgeDocument,
  useCreateMemoryEntry,
  useRejectMemoryEntry,
  useVerifyMemoryEntry,
} from "@multica/core/memory";
import { useWorkspaceId } from "@multica/core/hooks";
import type {
  CreateKnowledgeDocumentRequest,
  CreateMemoryEntryRequest,
  KnowledgeDocument,
  ListMemoryEntriesParams,
  MemoryEntry,
  MemoryExternalUsePolicy,
  MemoryScopeType,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multica/ui/components/ui/native-select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { PageHeader } from "../../layout/page-header";

type MemoryTabKey =
  | "all"
  | "identity"
  | "preference"
  | "rule"
  | "project"
  | "history"
  | "candidate"
  | "sources";

const MEMORY_TABS: {
  key: MemoryTabKey;
  label: string;
  description: string;
  type?: MemoryType;
  status?: MemoryStatus;
}[] = [
  { key: "all", label: "全部记忆", description: "AI-Me 可调用的当前记忆" },
  { key: "identity", label: "我的身份", description: "身份、角色和长期上下文", type: "identity" },
  { key: "preference", label: "我的偏好", description: "工作方式、表达和协作偏好", type: "preference" },
  { key: "rule", label: "判断规则", description: "需要稳定遵守的决策规则", type: "rule" },
  { key: "project", label: "项目知识", description: "项目事实和技术背景", type: "project_fact" },
  { key: "history", label: "历史经历", description: "可复用的历史处理经验", type: "history" },
  { key: "candidate", label: "候选记忆", description: "等待你确认或忽略", status: "candidate" },
  { key: "sources", label: "数据来源", description: "导入的知识来源和索引状态" },
];

const MEMORY_TYPES: { value: MemoryType; label: string }[] = [
  { value: "identity", label: "我的身份" },
  { value: "preference", label: "我的偏好" },
  { value: "rule", label: "判断规则" },
  { value: "project_fact", label: "项目知识" },
  { value: "process", label: "流程经验" },
  { value: "history", label: "历史经历" },
  { value: "relationship", label: "关系背景" },
  { value: "technical_context", label: "技术上下文" },
];

const SCOPE_TYPES: { value: MemoryScopeType; label: string }[] = [
  { value: "workspace", label: "整个工作区" },
  { value: "user", label: "只对我生效" },
  { value: "project", label: "指定项目" },
  { value: "agent", label: "指定 AI 员工" },
];

const SENSITIVITIES: { value: MemorySensitivity; label: string }[] = [
  { value: "normal", label: "普通" },
  { value: "private", label: "私密" },
  { value: "restricted", label: "受限" },
];

const EXTERNAL_POLICIES: { value: MemoryExternalUsePolicy; label: string }[] = [
  { value: "never", label: "不可用于对外表达" },
  { value: "with_approval", label: "对外使用前需要批准" },
  { value: "allowed", label: "允许用于对外表达" },
];

const EMPTY_MEMORIES: MemoryEntry[] = [];
const EMPTY_DOCUMENTS: KnowledgeDocument[] = [];

export function MemoryPage() {
  const wsId = useWorkspaceId();
  const [tab, setTab] = useState<MemoryTabKey>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createMemoryOpen, setCreateMemoryOpen] = useState(false);
  const [createSourceOpen, setCreateSourceOpen] = useState(false);

  const currentTab = MEMORY_TABS.find((item) => item.key === tab) ?? MEMORY_TABS[0]!;
  const isSourcesTab = tab === "sources";

  const params = useMemo<ListMemoryEntriesParams>(() => {
    const next: ListMemoryEntriesParams = { limit: 80 };
    if (currentTab.type) next.type = currentTab.type;
    if (currentTab.status) next.status = currentTab.status;
    const q = search.trim();
    if (q) next.q = q;
    return next;
  }, [currentTab.status, currentTab.type, search]);

  const allMemoryQuery = useQuery(memoryListOptions(wsId, { limit: 200 }));
  const memoryQuery = useQuery({
    ...memoryListOptions(wsId, params),
    enabled: !isSourcesTab,
  });
  const sourceQuery = useQuery(knowledgeDocumentListOptions(wsId, { limit: 100 }));

  const memories = isSourcesTab
    ? EMPTY_MEMORIES
    : memoryQuery.data?.memories ?? EMPTY_MEMORIES;
  const sources = sourceQuery.data?.documents ?? EMPTY_DOCUMENTS;

  useEffect(() => {
    if (isSourcesTab) {
      setSelectedId(null);
      return;
    }
    if (memories.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !memories.some((memory) => memory.id === selectedId)) {
      setSelectedId(memories[0]?.id ?? null);
    }
  }, [isSourcesTab, memories, selectedId]);

  const detailQuery = useQuery({
    ...memoryDetailOptions(wsId, selectedId ?? ""),
    enabled: !!selectedId && !isSourcesTab,
  });
  const selectedMemory =
    detailQuery.data?.id
      ? detailQuery.data
      : memories.find((memory) => memory.id === selectedId) ?? null;

  const allMemories = allMemoryQuery.data?.memories ?? EMPTY_MEMORIES;
  const stats = useMemo(() => buildStats(allMemories, sources), [allMemories, sources]);
  const isLoading = isSourcesTab
    ? sourceQuery.isLoading
    : memoryQuery.isLoading && !memoryQuery.data;
  const listError = isSourcesTab ? sourceQuery.error : memoryQuery.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)] text-[var(--aime-text)]">
      <PageHeader className="h-16 justify-between border-b border-[var(--aime-border)] bg-[var(--aime-surface)] px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpenText className="size-4 text-[var(--aime-brand-600)]" />
            <h1 className="truncate text-base font-semibold tracking-normal">记忆与知识</h1>
            <span className="font-mono text-xs tabular-nums text-[var(--aime-text-tertiary)]">
              {allMemoryQuery.data?.total ?? 0}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
            管理 AI-Me 能稳定记住、调用和引用的上下文。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateSourceOpen(true)}
            className="hidden border-[var(--aime-border-strong)] bg-[var(--aime-surface)] md:inline-flex"
          >
            <Database className="size-3.5" />
            登记来源
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setCreateMemoryOpen(true)}
            className="border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white shadow-[var(--aime-shadow-sm)] hover:bg-[var(--aime-brand-600)]"
          >
            <Plus className="size-3.5" />
            新增记忆
          </Button>
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <StatCard label="已确认记忆" value={stats.active} hint="可被 AI-Me 调用" tone="success" />
          <StatCard label="候选记忆" value={stats.candidate} hint="需要你确认" tone="warning" />
          <StatCard label="受限记忆" value={stats.restricted} hint="外部使用受控" tone="danger" />
          <StatCard label="可对外表达" value={stats.externalAllowed} hint="含需批准项" tone="info" />
          <StatCard label="知识来源" value={stats.sources} hint="导入或登记来源" tone="brand" />
        </div>

        <div className="grid min-h-[640px] grid-cols-1 gap-4 xl:grid-cols-[240px_minmax(0,1fr)_392px]">
          <CategoryRail
            tab={tab}
            onTabChange={setTab}
            memories={allMemories}
            sourcesCount={sources.length}
          />

          <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
            <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--aime-border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{currentTab.label}</h2>
                  <span className="rounded-full bg-[var(--aime-surface-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--aime-text-tertiary)]">
                    {isSourcesTab ? sources.length : memoryQuery.data?.total ?? memories.length}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
                  {currentTab.description}
                </p>
              </div>
              {!isSourcesTab && (
                <div className="relative w-full lg:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--aime-text-tertiary)]" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索记忆内容、标题或分类"
                    className="h-8 rounded-lg border-[var(--aime-border-strong)] bg-[var(--aime-surface)] pl-8 text-sm"
                  />
                </div>
              )}
            </div>

            {isLoading ? (
              <ListSkeleton />
            ) : listError ? (
              <ErrorState error={listError} />
            ) : isSourcesTab ? (
              <SourceList sources={sources} />
            ) : memories.length === 0 ? (
              <EmptyMemoryState onCreate={() => setCreateMemoryOpen(true)} />
            ) : (
              <MemoryList
                memories={memories}
                selectedId={selectedMemory?.id ?? null}
                onSelect={setSelectedId}
              />
            )}
          </section>

          <MemoryDetailPanel memory={selectedMemory} loading={detailQuery.isLoading} />
        </div>
      </div>

      <CreateMemoryDialog
        open={createMemoryOpen}
        onOpenChange={setCreateMemoryOpen}
      />
      <CreateSourceDialog
        open={createSourceOpen}
        onOpenChange={setCreateSourceOpen}
      />
    </div>
  );
}

function CategoryRail({
  tab,
  onTabChange,
  memories,
  sourcesCount,
}: {
  tab: MemoryTabKey;
  onTabChange: (tab: MemoryTabKey) => void;
  memories: MemoryEntry[];
  sourcesCount: number;
}) {
  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-2 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-center gap-2 px-2 py-2 text-xs font-semibold text-[var(--aime-text-tertiary)]">
        <Filter className="size-3.5" />
        分类
      </div>
      <div className="space-y-1">
        {MEMORY_TABS.map((item) => {
          const count = item.key === "sources"
            ? sourcesCount
            : countForTab(memories, item);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onTabChange(item.key)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                tab === item.key
                  ? "bg-[var(--aime-brand-50)] text-[var(--aime-brand-700)]"
                  : "text-[var(--aime-text-secondary)] hover:bg-[var(--aime-surface-muted)] hover:text-[var(--aime-text)]",
              )}
            >
              <span className="min-w-0 truncate">{item.label}</span>
              <span className="font-mono text-[11px] tabular-nums text-[var(--aime-text-tertiary)]">
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function MemoryList({
  memories,
  selectedId,
  onSelect,
}: {
  memories: MemoryEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-[1] grid h-9 grid-cols-[minmax(0,1fr)_108px_96px_116px] items-center gap-3 border-b border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-4 text-xs font-semibold text-[var(--aime-text-tertiary)]">
        <span>内容</span>
        <span>类型</span>
        <span>置信度</span>
        <span>最近验证</span>
      </div>
      {memories.map((memory) => (
        <button
          key={memory.id}
          type="button"
          onClick={() => onSelect(memory.id)}
          className={cn(
            "grid w-full grid-cols-[minmax(0,1fr)_108px_96px_116px] items-center gap-3 border-b border-[var(--aime-border)] px-4 py-3 text-left transition-colors",
            selectedId === memory.id
              ? "bg-[var(--aime-brand-50)]"
              : "hover:bg-[var(--aime-surface-subtle)]",
          )}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-[var(--aime-text)]">
                {memory.title}
              </span>
              <StatusBadge status={memory.status} />
            </div>
            <p className="mt-1 line-clamp-1 text-xs text-[var(--aime-text-secondary)]">
              {memory.summary || memory.content}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--aime-text-tertiary)]">
              <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5">
                {scopeLabel(memory.scope_type)}
              </span>
              <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5">
                {externalPolicyLabel(memory.external_use_policy)}
              </span>
              {memory.category && (
                <span className="rounded-md bg-[var(--aime-surface-muted)] px-1.5 py-0.5">
                  {memory.category}
                </span>
              )}
            </div>
          </div>
          <span className="truncate text-xs text-[var(--aime-text-secondary)]">
            {typeLabel(memory.type)}
          </span>
          <Confidence value={memory.confidence} />
          <span className="text-xs text-[var(--aime-text-tertiary)]">
            {memory.verified_at ? formatRelative(memory.verified_at) : "未验证"}
          </span>
        </button>
      ))}
    </div>
  );
}

function MemoryDetailPanel({
  memory,
  loading,
}: {
  memory: MemoryEntry | null;
  loading: boolean;
}) {
  const confirmMutation = useConfirmMemoryEntry();
  const rejectMutation = useRejectMemoryEntry();
  const archiveMutation = useArchiveMemoryEntry();
  const verifyMutation = useVerifyMemoryEntry();

  if (loading && !memory) {
    return (
      <aside className="hidden min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)] xl:flex">
        <Skeleton className="h-7 w-40 rounded-md" />
        <Skeleton className="mt-3 h-24 w-full rounded-xl" />
        <Skeleton className="mt-4 h-32 w-full rounded-xl" />
      </aside>
    );
  }

  if (!memory) {
    return (
      <aside className="hidden min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)] xl:flex">
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <Sparkles className="size-8 text-[var(--aime-text-tertiary)]" />
          <p className="mt-3 text-sm font-medium">选择一条记忆</p>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            右侧会展示内容、来源证据、调用范围和最近使用记录。
          </p>
        </div>
      </aside>
    );
  }

  const actionPending =
    confirmMutation.isPending ||
    rejectMutation.isPending ||
    archiveMutation.isPending ||
    verifyMutation.isPending;

  const runAction = async (
    action: () => Promise<MemoryEntry>,
    successMessage: string,
  ) => {
    try {
      await action();
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)] xl:flex">
      <div className="shrink-0 border-b border-[var(--aime-border)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase text-[var(--aime-text-tertiary)]">
              {typeLabel(memory.type)}
            </p>
            <h3 className="mt-1 text-base font-semibold leading-6">{memory.title}</h3>
          </div>
          <StatusBadge status={memory.status} />
        </div>
        <p className="mt-3 text-sm leading-6 text-[var(--aime-text-secondary)]">
          {memory.content}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <SectionTitle>调用策略</SectionTitle>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <InfoCell label="范围" value={scopeLabel(memory.scope_type)} />
            <InfoCell label="敏感度" value={sensitivityLabel(memory.sensitivity)} />
            <InfoCell label="对外表达" value={externalPolicyLabel(memory.external_use_policy)} />
            <InfoCell label="置信度" value={`${Math.round(memory.confidence * 100)}%`} />
          </div>
        </section>

        <section>
          <SectionTitle>来源证据</SectionTitle>
          <div className="mt-3 space-y-2">
            {(memory.evidence ?? []).length > 0 ? (
              (memory.evidence ?? []).map((item) => (
                <div key={item.id} className="rounded-xl border border-[var(--aime-border)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 truncate text-xs font-semibold text-[var(--aime-text)]">
                      {item.source.title || item.source.source_type}
                    </p>
                    <span className="shrink-0 text-[11px] text-[var(--aime-text-tertiary)]">
                      {Math.round(item.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[var(--aime-text-secondary)]">
                    {item.excerpt || item.source.excerpt || "没有摘录"}
                  </p>
                  {item.location && (
                    <p className="mt-2 text-[11px] text-[var(--aime-text-tertiary)]">
                      {item.location}
                    </p>
                  )}
                </div>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
                这条记忆还没有绑定来源证据。
              </p>
            )}
          </div>
        </section>

        <section>
          <SectionTitle>最近使用</SectionTitle>
          <div className="mt-3 divide-y divide-[var(--aime-border)]">
            {(memory.usage ?? []).length > 0 ? (
              (memory.usage ?? []).map((item) => (
                <div key={item.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium text-[var(--aime-text)]">
                      {item.action || "used"}
                    </p>
                    <span className="text-[11px] text-[var(--aime-text-tertiary)]">
                      {formatRelative(item.created_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                    {item.used_by_type} · {item.outcome || "记录完成"}
                  </p>
                </div>
              ))
            ) : (
              <p className="py-3 text-sm text-[var(--aime-text-tertiary)]">
                还没有调用记录。
              </p>
            )}
          </div>
        </section>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-2 border-t border-[var(--aime-border)] p-3">
        {memory.status === "candidate" ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => runAction(() => rejectMutation.mutateAsync(memory.id), "已忽略候选记忆")}
              className="border-[var(--aime-border-strong)] bg-[var(--aime-surface)]"
            >
              <X className="size-3.5" />
              忽略
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => runAction(() => verifyMutation.mutateAsync(memory.id), "已重新验证")}
              className="border-[var(--aime-border-strong)] bg-[var(--aime-surface)]"
            >
              <ShieldCheck className="size-3.5" />
              验证
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={actionPending}
              onClick={() => runAction(() => confirmMutation.mutateAsync(memory.id), "已确认记忆")}
              className="border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
            >
              <Check className="size-3.5" />
              确认
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionPending}
              onClick={() => runAction(() => verifyMutation.mutateAsync(memory.id), "已重新验证")}
              className="col-span-2 border-[var(--aime-border-strong)] bg-[var(--aime-surface)]"
            >
              <ShieldCheck className="size-3.5" />
              重新验证
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionPending || memory.status === "archived"}
              onClick={() => runAction(() => archiveMutation.mutateAsync(memory.id), "已归档记忆")}
              className="border-[var(--aime-border-strong)] bg-[var(--aime-surface)] text-[var(--aime-danger)]"
            >
              <Archive className="size-3.5" />
              归档
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}

function SourceList({ sources }: { sources: KnowledgeDocument[] }) {
  if (sources.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <Database className="size-9 text-[var(--aime-text-tertiary)]" />
        <h3 className="mt-3 text-sm font-semibold">还没有知识来源</h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-[var(--aime-text-tertiary)]">
          可以先登记 URL、文档或手动资料来源；真正的解析和索引队列会在下一步接上。
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-[1] grid h-9 grid-cols-[minmax(0,1fr)_120px_112px_120px] items-center gap-3 border-b border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] px-4 text-xs font-semibold text-[var(--aime-text-tertiary)]">
        <span>来源</span>
        <span>类型</span>
        <span>状态</span>
        <span>更新时间</span>
      </div>
      {sources.map((source) => (
        <div
          key={source.id}
          className="grid grid-cols-[minmax(0,1fr)_120px_112px_120px] items-center gap-3 border-b border-[var(--aime-border)] px-4 py-3"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="size-4 shrink-0 text-[var(--aime-text-tertiary)]" />
              <span className="truncate text-sm font-semibold">{source.title}</span>
            </div>
            <p className="mt-1 truncate text-xs text-[var(--aime-text-tertiary)]">
              {source.source_url ?? source.attachment_id ?? "手动登记"}
            </p>
          </div>
          <span className="text-xs text-[var(--aime-text-secondary)]">{source.source_type}</span>
          <DocumentStatusBadge status={source.status} />
          <span className="text-xs text-[var(--aime-text-tertiary)]">
            {formatRelative(source.updated_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function CreateMemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMemory = useCreateMemoryEntry();
  const [form, setForm] = useState<CreateMemoryEntryRequest>({
    type: "preference",
    title: "",
    content: "",
    summary: "",
    category: "",
    status: "active",
    confidence: 0.8,
    sensitivity: "normal",
    scope_type: "workspace",
    external_use_policy: "with_approval",
    source_mode: "manual",
  });

  useEffect(() => {
    if (!open) return;
    setForm({
      type: "preference",
      title: "",
      content: "",
      summary: "",
      category: "",
      status: "active",
      confidence: 0.8,
      sensitivity: "normal",
      scope_type: "workspace",
      external_use_policy: "with_approval",
      source_mode: "manual",
    });
  }, [open]);

  const submit = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      toast.error("标题和内容不能为空");
      return;
    }
    try {
      await createMemory.mutateAsync({
        ...form,
        title: form.title.trim(),
        content: form.content.trim(),
        summary: form.summary?.trim(),
        category: form.category?.trim(),
      });
      toast.success("已新增记忆");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新增记忆失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新增记忆</DialogTitle>
          <DialogDescription>
            手动写入的记忆会直接进入 active 状态，后续 AI-Me 可按策略调用。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              类型
              <NativeSelect
                value={form.type}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  type: event.target.value as MemoryType,
                }))}
                className="w-full"
              >
                {MEMORY_TYPES.map((item) => (
                  <NativeSelectOption key={item.value} value={item.value}>
                    {item.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              分类
              <Input
                value={form.category ?? ""}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  category: event.target.value,
                }))}
                placeholder="例如：沟通、支付、发版"
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            标题
            <Input
              value={form.title}
              onChange={(event) => setForm((current) => ({
                ...current,
                title: event.target.value,
              }))}
              placeholder="一句话概括这条记忆"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            内容
            <Textarea
              value={form.content}
              onChange={(event) => setForm((current) => ({
                ...current,
                content: event.target.value,
              }))}
              placeholder="写清楚 AI-Me 未来应该记住什么"
              className="min-h-28"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            摘要
            <Input
              value={form.summary ?? ""}
              onChange={(event) => setForm((current) => ({
                ...current,
                summary: event.target.value,
              }))}
              placeholder="列表中展示的短摘要，可留空"
            />
          </label>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-medium">
              适用范围
              <NativeSelect
                value={form.scope_type}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  scope_type: event.target.value as MemoryScopeType,
                }))}
                className="w-full"
              >
                {SCOPE_TYPES.map((item) => (
                  <NativeSelectOption key={item.value} value={item.value}>
                    {item.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              敏感度
              <NativeSelect
                value={form.sensitivity}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  sensitivity: event.target.value as MemorySensitivity,
                }))}
                className="w-full"
              >
                {SENSITIVITIES.map((item) => (
                  <NativeSelectOption key={item.value} value={item.value}>
                    {item.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              对外表达
              <NativeSelect
                value={form.external_use_policy}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  external_use_policy: event.target.value as MemoryExternalUsePolicy,
                }))}
                className="w-full"
              >
                {EXTERNAL_POLICIES.map((item) => (
                  <NativeSelectOption key={item.value} value={item.value}>
                    {item.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={createMemory.isPending}
            onClick={submit}
            className="bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
          >
            保存记忆
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateSourceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createSource = useCreateKnowledgeDocument();
  const [form, setForm] = useState<CreateKnowledgeDocumentRequest>({
    title: "",
    source_type: "manual",
    source_url: "",
    status: "queued",
    metadata: {},
  });

  useEffect(() => {
    if (!open) return;
    setForm({
      title: "",
      source_type: "manual",
      source_url: "",
      status: "queued",
      metadata: {},
    });
  }, [open]);

  const submit = async () => {
    if (!form.title.trim()) {
      toast.error("来源标题不能为空");
      return;
    }
    try {
      await createSource.mutateAsync({
        ...form,
        title: form.title.trim(),
        source_type: form.source_type.trim() || "manual",
        source_url: form.source_url?.trim(),
      });
      toast.success("已登记知识来源");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "登记来源失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>登记知识来源</DialogTitle>
          <DialogDescription>
            v0.1 先记录来源和状态，后续再接解析、分块和索引队列。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            标题
            <Input
              value={form.title}
              onChange={(event) => setForm((current) => ({
                ...current,
                title: event.target.value,
              }))}
              placeholder="例如：支付服务排查手册"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            来源类型
            <Input
              value={form.source_type}
              onChange={(event) => setForm((current) => ({
                ...current,
                source_type: event.target.value,
              }))}
              placeholder="manual / url / document"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            URL
            <Input
              value={form.source_url ?? ""}
              onChange={(event) => setForm((current) => ({
                ...current,
                source_url: event.target.value,
              }))}
              placeholder="可留空"
            />
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={createSource.isPending}
            onClick={submit}
            className="bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
          >
            保存来源
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "brand" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <span className={cn("text-xs font-medium", toneTextClass(tone))}>{label}</span>
      <div className="mt-2 flex items-end justify-between gap-3">
        <span className="font-mono text-3xl font-semibold leading-none tracking-normal">
          {value}
        </span>
        <span className="text-right text-xs text-[var(--aime-text-tertiary)]">
          {hint}
        </span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: MemoryStatus }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
      status === "active" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      status === "candidate" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
      status === "rejected" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
      status === "archived" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
    )}>
      {statusLabel(status)}
    </span>
  );
}

function DocumentStatusBadge({ status }: { status: KnowledgeDocument["status"] }) {
  return (
    <span className={cn(
      "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
      status === "ready" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
      (status === "queued" || status === "processing") && "bg-[var(--aime-info-bg)] text-[var(--aime-info)]",
      status === "failed" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
      status === "archived" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
    )}>
      {documentStatusLabel(status)}
    </span>
  );
}

function Confidence({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div className="min-w-0">
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--aime-surface-muted)]">
        <div
          className="h-full rounded-full bg-[var(--aime-brand-500)]"
          style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--aime-text-tertiary)]">
        {percent}%
      </p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

function EmptyMemoryState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <Sparkles className="size-9 text-[var(--aime-text-tertiary)]" />
      <h3 className="mt-3 text-sm font-semibold">这里还没有记忆</h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-[var(--aime-text-tertiary)]">
        可以先手动添加几条偏好、规则或项目事实，让 AI-Me 的判断更稳定。
      </p>
      <Button
        type="button"
        size="sm"
        onClick={onCreate}
        className="mt-4 bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
      >
        <Plus className="size-3.5" />
        新增记忆
      </Button>
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <AlertCircle className="size-8 text-[var(--aime-danger)]" />
      <p className="text-sm font-medium">加载失败</p>
      <p className="max-w-md text-xs leading-5 text-[var(--aime-text-tertiary)]">
        {error instanceof Error ? error.message : "请稍后重试"}
      </p>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold tracking-normal">{children}</h4>;
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--aime-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--aime-text-tertiary)]">{label}</p>
      <p className="mt-1 text-xs font-semibold text-[var(--aime-text)]">{value}</p>
    </div>
  );
}

function buildStats(memories: MemoryEntry[], sources: KnowledgeDocument[]) {
  return {
    active: memories.filter((memory) => memory.status === "active").length,
    candidate: memories.filter((memory) => memory.status === "candidate").length,
    restricted: memories.filter((memory) => memory.sensitivity === "restricted").length,
    externalAllowed: memories.filter((memory) => memory.external_use_policy !== "never").length,
    sources: sources.length,
  };
}

function countForTab(memories: MemoryEntry[], tab: (typeof MEMORY_TABS)[number]) {
  return memories.filter((memory) => {
    if (tab.type && memory.type !== tab.type) return false;
    if (tab.status && memory.status !== tab.status) return false;
    return true;
  }).length;
}

function typeLabel(type: MemoryType): string {
  return MEMORY_TYPES.find((item) => item.value === type)?.label ?? type;
}

function statusLabel(status: MemoryStatus): string {
  switch (status) {
    case "active":
      return "已确认";
    case "candidate":
      return "候选";
    case "rejected":
      return "已忽略";
    case "archived":
      return "已归档";
  }
}

function documentStatusLabel(status: KnowledgeDocument["status"]): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "processing":
      return "处理中";
    case "ready":
      return "已就绪";
    case "failed":
      return "失败";
    case "archived":
      return "已归档";
  }
}

function scopeLabel(scope: MemoryScopeType): string {
  return SCOPE_TYPES.find((item) => item.value === scope)?.label ?? scope;
}

function sensitivityLabel(sensitivity: MemorySensitivity): string {
  return SENSITIVITIES.find((item) => item.value === sensitivity)?.label ?? sensitivity;
}

function externalPolicyLabel(policy: MemoryExternalUsePolicy): string {
  return EXTERNAL_POLICIES.find((item) => item.value === policy)?.label ?? policy;
}

function toneTextClass(tone: "brand" | "success" | "warning" | "danger" | "info") {
  switch (tone) {
    case "brand":
      return "text-[var(--aime-brand-600)]";
    case "success":
      return "text-[var(--aime-success)]";
    case "warning":
      return "text-[var(--aime-warning)]";
    case "danger":
      return "text-[var(--aime-danger)]";
    case "info":
      return "text-[var(--aime-info)]";
  }
}

function formatRelative(value: string): string {
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
