"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Plus,
  Search,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AgentRuntime,
  AgentTask,
  CreateAgentRequest,
} from "@multica/core/types";
import {
  type AgentActivity,
  type AgentPresenceDetail,
  agentRunCounts30dOptions,
  agentTaskSnapshotOptions,
  summarizeActivityWindow,
  useWorkspaceActivityMap,
  useWorkspacePresenceMap,
} from "@multica/core/agents";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useQuickCreateStore } from "@multica/core/issues/stores/quick-create-store";
import { useModalStore } from "@multica/core/modals";
import { canAssignAgentToIssue } from "@multica/core/permissions";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  agentListOptions,
  memberListOptions,
  workspaceKeys,
} from "@multica/core/workspace/queries";
import { runtimeListOptions } from "@multica/core/runtimes";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { availabilityConfig } from "../presence";
import { AgentRowActions } from "./agent-row-actions";
import { CreateAgentDialog } from "./create-agent-dialog";
import { Sparkline } from "./sparkline";
import { useT } from "../../i18n";

type View = "active" | "archived";
type WorkerTab = "all" | "codex" | "claude" | "other";

const WORKER_TABS: WorkerTab[] = ["all", "codex", "claude", "other"];
const ACTIVE_TASK_STATUS = new Set(["queued", "dispatched", "running"]);
const TERMINAL_TASK_STATUS = new Set(["completed", "failed", "cancelled"]);

interface WorkerRow {
  agent: Agent;
  runtime: AgentRuntime | null;
  presence: AgentPresenceDetail | null | undefined;
  activity: AgentActivity | null | undefined;
  tasks: AgentTask[];
  currentTask: AgentTask | null;
  recentTasks: AgentTask[];
  runCount: number;
  todayRuns: number;
  successRate: number | null;
  avgDurationLabel: string;
  workDirLabel: string;
  canManage: boolean;
  provider: string;
  tab: Exclude<WorkerTab, "all">;
}

export function AgentsPage() {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const openModal = useModalStore((s) => s.open);
  const setQuickCreateAgent = useQuickCreateStore((s) => s.setLastAgentId);

  const {
    data: agents = [],
    isLoading,
    error: listError,
    refetch: refetchList,
  } = useQuery(agentListOptions(wsId));
  const { data: runtimes = [], isLoading: runtimesLoading } = useQuery(
    runtimeListOptions(wsId),
  );
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: runCountsRaw = [] } = useQuery(agentRunCounts30dOptions(wsId));
  const { data: taskSnapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));
  const { byAgent: presenceMap } = useWorkspacePresenceMap(wsId);
  const { byAgent: activityMap } = useWorkspaceActivityMap(wsId);

  const [view, setView] = useState<View>("active");
  const [tab, setTab] = useState<WorkerTab>("all");
  const [search, setSearch] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [duplicateTemplate, setDuplicateTemplate] = useState<Agent | null>(
    null,
  );

  const runtimesById = useMemo(() => {
    const map = new Map<string, AgentRuntime>();
    for (const runtime of runtimes) map.set(runtime.id, runtime);
    return map;
  }, [runtimes]);

  const runCountsById = useMemo(() => {
    const map = new Map<string, number>();
    for (const count of runCountsRaw) map.set(count.agent_id, count.run_count);
    return map;
  }, [runCountsRaw]);

  const tasksByAgent = useMemo(() => {
    const map = new Map<string, AgentTask[]>();
    for (const task of taskSnapshot) {
      const existing = map.get(task.agent_id);
      if (existing) existing.push(task);
      else map.set(task.agent_id, [task]);
    }
    for (const tasks of map.values()) {
      tasks.sort((a, b) => taskTime(b) - taskTime(a));
    }
    return map;
  }, [taskSnapshot]);

  const myRole = useMemo(() => {
    if (!currentUser) return null;
    return members.find((member) => member.user_id === currentUser.id)?.role ?? null;
  }, [members, currentUser]);
  const isWorkspaceAdmin = myRole === "owner" || myRole === "admin";

  const visibleAgents = useMemo(() => {
    return agents.filter((agent) => {
      const inRequestedLifecycle =
        view === "archived" ? !!agent.archived_at : !agent.archived_at;
      if (!inRequestedLifecycle) return false;
      return canAssignAgentToIssue(agent, {
        userId: currentUser?.id ?? null,
        role: myRole,
      }).allowed;
    });
  }, [agents, currentUser?.id, myRole, view]);

  const workerRows = useMemo<WorkerRow[]>(() => {
    return visibleAgents.map((agent) => {
      const runtime = runtimesById.get(agent.runtime_id) ?? null;
      const tasks = tasksByAgent.get(agent.id) ?? [];
      const currentTask = pickCurrentTask(tasks);
      const activity = activityMap.get(agent.id) ?? null;
      const todayRuns = summarizeActivityWindow(activity ?? undefined, 1).totalRuns;
      const sevenDay = summarizeActivityWindow(activity ?? undefined, 7);
      const successRate =
        sevenDay.totalRuns > 0
          ? Math.round(((sevenDay.totalRuns - sevenDay.totalFailed) / sevenDay.totalRuns) * 100)
          : null;
      const provider = runtime?.provider ?? "unknown";
      const isOwner = !!currentUser?.id && agent.owner_id === currentUser.id;
      const canManage = isWorkspaceAdmin || isOwner;
      return {
        agent,
        runtime,
        presence: presenceMap.get(agent.id) ?? null,
        activity,
        tasks,
        currentTask,
        recentTasks: tasks.filter((task) => TERMINAL_TASK_STATUS.has(task.status)).slice(0, 3),
        runCount: runCountsById.get(agent.id) ?? 0,
        todayRuns,
        successRate,
        avgDurationLabel: formatAverageDuration(tasks, t),
        workDirLabel: workDirLabel(agent, currentTask, t),
        canManage,
        provider,
        tab: providerToTab(provider),
      };
    });
  }, [
    visibleAgents,
    runtimesById,
    tasksByAgent,
    activityMap,
    currentUser?.id,
    isWorkspaceAdmin,
    presenceMap,
    runCountsById,
    t,
  ]);

  const tabCounts = useMemo(() => {
    const counts: Record<WorkerTab, number> = {
      all: workerRows.length,
      codex: 0,
      claude: 0,
      other: 0,
    };
    for (const row of workerRows) counts[row.tab] += 1;
    return counts;
  }, [workerRows]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workerRows.filter((row) => {
      if (tab !== "all" && row.tab !== tab) return false;
      if (!query) return true;
      return (
        row.agent.name.toLowerCase().includes(query) ||
        row.agent.description.toLowerCase().includes(query) ||
        row.provider.toLowerCase().includes(query)
      );
    });
  }, [workerRows, search, tab]);

  const metrics = useMemo(() => buildMetrics(workerRows, t), [workerRows, t]);

  const archivedCount = useMemo(
    () => agents.filter((agent) => !!agent.archived_at).length,
    [agents],
  );
  const activeCount = useMemo(
    () => agents.filter((agent) => !agent.archived_at).length,
    [agents],
  );

  useEffect(() => {
    if (view === "archived" && archivedCount === 0) setView("active");
  }, [view, archivedCount]);

  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedAgentId(null);
      return;
    }
    const stillVisible = filteredRows.some(
      (row) => row.agent.id === selectedAgentId,
    );
    if (!stillVisible) setSelectedAgentId(filteredRows[0]?.agent.id ?? null);
  }, [filteredRows, selectedAgentId]);

  const selectedRow =
    filteredRows.find((row) => row.agent.id === selectedAgentId) ??
    filteredRows[0] ??
    null;

  const handleCreate = async (data: CreateAgentRequest) => {
    const agent = await api.createAgent(data);
    let cachedAgent = agent;
    if (duplicateTemplate?.skills.length) {
      try {
        await api.setAgentSkills(agent.id, {
          skill_ids: duplicateTemplate.skills.map((skill) => skill.id),
        });
        cachedAgent = { ...agent, skills: duplicateTemplate.skills };
      } catch {
        // The employee is created; skill attachment can be retried later.
      }
    }
    qc.setQueryData<Agent[]>(workspaceKeys.agents(wsId), (current = []) => {
      const exists = current.some((item) => item.id === cachedAgent.id);
      return exists
        ? current.map((item) => (item.id === cachedAgent.id ? cachedAgent : item))
        : [...current, cachedAgent];
    });
    setShowCreate(false);
    setDuplicateTemplate(null);
    navigation.push(paths.agentDetail(agent.id));
    qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
  };

  const handleDuplicate = useCallback((agent: Agent) => {
    setDuplicateTemplate(agent);
    setShowCreate(true);
  }, []);

  const handleAssignTask = useCallback(
    (agent: Agent) => {
      setQuickCreateAgent(agent.id);
      openModal("quick-create-issue");
    },
    [openModal, setQuickCreateAgent],
  );

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)]">
        <PageHeaderBar
          totalCount={0}
          onCreate={() => setShowCreate(true)}
          onTemplate={() => setShowCreate(true)}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden p-6">
          <PageIntroSkeleton />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-xl" />
            ))}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_392px]">
            <Skeleton className="min-h-96 rounded-2xl" />
            <Skeleton className="hidden rounded-2xl xl:block" />
          </div>
        </div>
      </div>
    );
  }

  if (listError) {
    return (
      <ListError
        listError={listError}
        onCreate={() => setShowCreate(true)}
        onRetry={refetchList}
      />
    );
  }

  const showEmpty = activeCount === 0 && archivedCount === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)] text-[var(--aime-text)]">
      <PageHeaderBar
        totalCount={activeCount}
        onCreate={() => setShowCreate(true)}
        onTemplate={() => setShowCreate(true)}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6">
        {showEmpty ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState onCreate={() => setShowCreate(true)} />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-2xl font-semibold tracking-normal">
                  {t(($) => $.worker_page.title)}
                </h2>
                <p className="mt-1 text-sm leading-6 text-[var(--aime-text-secondary)]">
                  {t(($) => $.worker_page.description)}
                </p>
              </div>
              {archivedCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setView(view === "archived" ? "active" : "archived")}
                  className="self-start border-[var(--aime-border-strong)] bg-[var(--aime-surface)]"
                >
                  {view === "archived" && <ArrowLeft className="size-3.5" />}
                  {view === "archived"
                    ? t(($) => $.archived.active_link)
                    : t(($) => $.page.show_archived, { count: archivedCount })}
                </Button>
              )}
            </div>

            {view === "active" && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
                {metrics.map((metric) => (
                  <MetricCard key={metric.key} metric={metric} />
                ))}
              </div>
            )}

            <div className="grid min-h-[620px] grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_392px]">
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)]">
                <WorkerToolbar
                  tab={tab}
                  onTabChange={setTab}
                  counts={tabCounts}
                  search={search}
                  onSearchChange={setSearch}
                  view={view}
                />
                {filteredRows.length === 0 ? (
                  <NoMatches view={view} search={search} />
                ) : (
                  <WorkerTable
                    rows={filteredRows}
                    selectedAgentId={selectedRow?.agent.id ?? null}
                    onSelect={setSelectedAgentId}
                    onOpenDetail={(agent) => navigation.push(paths.agentDetail(agent.id))}
                    onDuplicate={handleDuplicate}
                  />
                )}
              </section>

              <WorkerDetailPanel
                row={selectedRow}
                onOpenDetail={(agent) => navigation.push(paths.agentDetail(agent.id))}
                onAssignTask={handleAssignTask}
              />
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <CreateAgentDialog
          runtimes={runtimes}
          runtimesLoading={runtimesLoading}
          members={members}
          currentUserId={currentUser?.id ?? null}
          template={duplicateTemplate}
          onClose={() => {
            setShowCreate(false);
            setDuplicateTemplate(null);
          }}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

function PageHeaderBar({
  totalCount,
  onCreate,
  onTemplate,
}: {
  totalCount: number;
  onCreate: () => void;
  onTemplate: () => void;
}) {
  const { t } = useT("agents");
  return (
    <PageHeader className="h-16 justify-between border-b border-[var(--aime-border)] bg-[var(--aime-surface)] px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-semibold tracking-normal">
            {t(($) => $.worker_page.header_title)}
          </h1>
          {totalCount > 0 && (
            <span className="font-mono text-xs tabular-nums text-[var(--aime-text-tertiary)]">
              {totalCount}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
          {t(($) => $.worker_page.header_description)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTemplate}
          className="hidden border-[var(--aime-border-strong)] bg-[var(--aime-surface)] md:inline-flex"
        >
          {t(($) => $.worker_page.templates)}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onCreate}
          className="border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white shadow-[var(--aime-shadow-sm)] hover:bg-[var(--aime-brand-600)]"
        >
          <Plus className="size-3.5" />
          {t(($) => $.worker_page.add_worker)}
        </Button>
      </div>
    </PageHeader>
  );
}

function PageIntroSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-36 rounded-md" />
      <Skeleton className="h-5 w-96 max-w-full rounded-md" />
    </div>
  );
}

function ListError({
  listError,
  onCreate,
  onRetry,
}: {
  listError: unknown;
  onCreate: () => void;
  onRetry: () => void;
}) {
  const { t } = useT("agents");
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--aime-bg)]">
      <PageHeaderBar totalCount={0} onCreate={onCreate} onTemplate={onCreate} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <AlertCircle className="size-8 text-destructive" />
        <div>
          <p className="text-sm font-medium">{t(($) => $.page.list_load_failed)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {listError instanceof Error
              ? listError.message
              : t(($) => $.page.list_load_failed_default)}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => $.page.try_again)}
        </Button>
      </div>
    </div>
  );
}

interface Metric {
  key: string;
  label: string;
  value: string;
  sub: string;
  tone: "brand" | "success" | "info" | "warning" | "danger";
}

function MetricCard({ metric }: { metric: Metric }) {
  return (
    <div className="rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface)] p-4 shadow-[var(--aime-shadow-xs)]">
      <div className="flex items-center justify-between gap-3">
        <span className={cn("text-xs font-medium", metricToneClass(metric.tone))}>
          {metric.label}
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <span className="font-mono text-3xl font-semibold leading-none tracking-normal text-[var(--aime-text)]">
          {metric.value}
        </span>
        <span className="text-right text-xs text-[var(--aime-text-tertiary)]">
          {metric.sub}
        </span>
      </div>
    </div>
  );
}

function WorkerToolbar({
  tab,
  onTabChange,
  counts,
  search,
  onSearchChange,
  view,
}: {
  tab: WorkerTab;
  onTabChange: (tab: WorkerTab) => void;
  counts: Record<WorkerTab, number>;
  search: string;
  onSearchChange: (value: string) => void;
  view: View;
}) {
  const { t } = useT("agents");
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--aime-border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-5 overflow-x-auto">
        {WORKER_TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onTabChange(item)}
            className={cn(
              "relative shrink-0 whitespace-nowrap pb-2 text-xs font-semibold transition-colors",
              tab === item
                ? "text-[var(--aime-brand-600)]"
                : "text-[var(--aime-text-tertiary)] hover:text-[var(--aime-text)]",
            )}
          >
            {t(($) => $.worker_page.tabs[item])}
            <span className="ml-1 font-mono font-medium tabular-nums">
              {counts[item]}
            </span>
            {tab === item && (
              <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-[var(--aime-brand-500)]" />
            )}
          </button>
        ))}
      </div>
      <div className="relative w-full lg:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--aime-text-tertiary)]" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={
            view === "archived"
              ? t(($) => $.worker_page.search_archived_placeholder)
              : t(($) => $.worker_page.search_placeholder)
          }
          className="h-9 rounded-lg border-[var(--aime-border-strong)] bg-[var(--aime-surface)] pl-9 text-sm"
        />
      </div>
    </div>
  );
}

function WorkerTable({
  rows,
  selectedAgentId,
  onSelect,
  onOpenDetail,
  onDuplicate,
}: {
  rows: WorkerRow[];
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
  onOpenDetail: (agent: Agent) => void;
  onDuplicate: (agent: Agent) => void;
}) {
  const { t } = useT("agents");
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full min-w-[920px] table-fixed text-sm">
        <thead className="sticky top-0 z-10 bg-[var(--aime-surface-subtle)]">
          <tr className="border-b border-[var(--aime-border)] text-left text-xs font-medium text-[var(--aime-text-tertiary)]">
            <th className="w-[26%] px-4 py-3">{t(($) => $.worker_page.columns.worker)}</th>
            <th className="w-[10%] px-4 py-3">{t(($) => $.worker_page.columns.status)}</th>
            <th className="w-[18%] px-4 py-3">{t(($) => $.worker_page.columns.current_task)}</th>
            <th className="w-[18%] px-4 py-3">{t(($) => $.worker_page.columns.work_dir)}</th>
            <th className="w-[9%] px-4 py-3 text-right">{t(($) => $.worker_page.columns.today_runs)}</th>
            <th className="w-[10%] px-4 py-3 text-right">{t(($) => $.worker_page.columns.avg_duration)}</th>
            <th className="w-[9%] px-4 py-3 text-right">{t(($) => $.worker_page.columns.success_rate)}</th>
            <th className="w-12 px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = selectedAgentId === row.agent.id;
            return (
              <tr
                key={row.agent.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(row.agent.id)}
                onDoubleClick={() => onOpenDetail(row.agent)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(row.agent.id);
                  }
                }}
                className={cn(
                  "cursor-pointer border-b border-[var(--aime-border)] outline-none transition-colors hover:bg-[var(--aime-surface-muted)] focus-visible:bg-[var(--aime-brand-50)]",
                  selected && "bg-[var(--aime-brand-50)]",
                )}
              >
                <td className="px-4 py-3">
                  <WorkerIdentity row={row} />
                </td>
                <td className="px-4 py-3">
                  <AvailabilityBadge presence={row.presence} archived={!!row.agent.archived_at} />
                </td>
                <td className="px-4 py-3">
                  <TaskCell task={row.currentTask} />
                </td>
                <td className="px-4 py-3">
                  <div className="truncate text-xs text-[var(--aime-text-secondary)]">
                    {row.workDirLabel}
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-[var(--aime-text-secondary)]">
                  {row.todayRuns}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-[var(--aime-text-secondary)]">
                  {row.avgDurationLabel}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums text-[var(--aime-text-secondary)]">
                  {formatPercent(row.successRate, t)}
                </td>
                <td
                  className="px-4 py-3"
                  onClick={(event) => event.stopPropagation()}
                >
                  <AgentRowActions
                    agent={row.agent}
                    presence={row.presence}
                    canManage={row.canManage}
                    onDuplicate={onDuplicate}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkerIdentity({ row }: { row: WorkerRow }) {
  const description =
    row.agent.description || row.runtime?.name || providerLabel(row.provider);

  return (
    <div className="flex min-w-0 items-center gap-3">
      <ActorAvatar
        actorType="agent"
        actorId={row.agent.id}
        size={30}
        className="shrink-0 rounded-lg"
      />
      <div className="min-w-0">
        <span className="block truncate text-sm font-semibold text-[var(--aime-text)]">
          {row.agent.name}
        </span>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--aime-text-tertiary)]">
          <span className="shrink-0 rounded-full bg-[var(--aime-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--aime-text-secondary)]">
            {providerLabel(row.provider)}
          </span>
          <span className="truncate">{description}</span>
        </p>
      </div>
    </div>
  );
}

function AvailabilityBadge({
  presence,
  archived,
}: {
  presence: AgentPresenceDetail | null | undefined;
  archived: boolean;
}) {
  const { t } = useT("agents");
  if (archived) {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--aime-surface-muted)] px-2 py-0.5 text-xs font-medium text-[var(--aime-text-tertiary)]">
        {t(($) => $.row.archived)}
      </span>
    );
  }
  if (!presence) {
    return <span className="inline-flex h-5 w-14 animate-pulse rounded-full bg-muted/60" />;
  }
  const cfg = availabilityConfig[presence.availability];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        presence.availability === "online" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
        presence.availability === "unstable" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        presence.availability === "offline" && "bg-[var(--aime-surface-muted)] text-[var(--aime-text-tertiary)]",
      )}
    >
      <span className={cn("size-1.5 rounded-full", cfg.dotClass)} />
      {t(($) => $.availability[presence.availability])}
    </span>
  );
}

function TaskCell({ task }: { task: AgentTask | null }) {
  const { t } = useT("agents");
  if (!task) {
    return <span className="text-xs text-[var(--aime-text-tertiary)]">{t(($) => $.worker_page.no_current_task)}</span>;
  }
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-semibold text-[var(--aime-text)]">
        {describeTask(task, t)}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--aime-text-tertiary)]">
        <TaskStatusDot status={task.status} />
        <span>{t(($) => $.worker_page.task_status[task.status])}</span>
      </div>
    </div>
  );
}

function WorkerDetailPanel({
  row,
  onOpenDetail,
  onAssignTask,
}: {
  row: WorkerRow | null;
  onOpenDetail: (agent: Agent) => void;
  onAssignTask: (agent: Agent) => void;
}) {
  const { t } = useT("agents");
  if (!row) {
    return (
      <aside className="hidden min-h-0 flex-col rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)] xl:flex">
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <Bot className="size-8 text-[var(--aime-text-tertiary)]" />
          <p className="mt-3 text-sm font-medium">{t(($) => $.worker_page.detail.empty_title)}</p>
          <p className="mt-1 text-xs leading-5 text-[var(--aime-text-tertiary)]">
            {t(($) => $.worker_page.detail.empty_description)}
          </p>
        </div>
      </aside>
    );
  }

  const currentTask = row.currentTask;

  return (
    <aside className="hidden min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] shadow-[var(--aime-shadow-xs)] xl:flex">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--aime-border)] p-4">
        <div className="flex min-w-0 items-center gap-3">
          <ActorAvatar
            actorType="agent"
            actorId={row.agent.id}
            size={38}
            className="shrink-0 rounded-xl"
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-[var(--aime-text)]">
              {row.agent.name}
            </h3>
            <p className="mt-0.5 truncate text-xs text-[var(--aime-text-tertiary)]">
              {providerLabel(row.provider)}
              {row.runtime?.name ? ` · ${row.runtime.name}` : ""}
            </p>
          </div>
        </div>
        <AvailabilityBadge presence={row.presence} archived={!!row.agent.archived_at} />
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <SectionTitle>{t(($) => $.worker_page.detail.current_task)}</SectionTitle>
          {currentTask ? (
            <div className="mt-3 rounded-xl border border-[var(--aime-border)] bg-[var(--aime-surface-subtle)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--aime-text)]">
                    {describeTask(currentTask, t)}
                  </p>
                  <p className="mt-1 truncate text-xs text-[var(--aime-text-tertiary)]">
                    {currentTask.trigger_summary || t(($) => $.worker_page.detail.current_task_hint)}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-medium text-[var(--aime-brand-600)]">
                  {t(($) => $.worker_page.task_status[currentTask.status])}
                </span>
              </div>
              {row.presence && (
                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--aime-brand-100)]">
                    <div
                      className="h-full rounded-full bg-[var(--aime-brand-500)]"
                      style={{
                        width: `${Math.min(100, Math.max(8, (row.presence.runningCount / Math.max(1, row.presence.capacity)) * 100))}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-[11px] text-[var(--aime-text-tertiary)]">
                    <span>
                      {t(($) => $.worker_page.detail.capacity, {
                        running: row.presence.runningCount,
                        capacity: row.presence.capacity,
                      })}
                    </span>
                    {row.presence.queuedCount > 0 && (
                      <span>
                        {t(($) => $.worker_page.detail.queued, {
                          count: row.presence.queuedCount,
                        })}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-2 rounded-xl border border-dashed border-[var(--aime-border)] px-3 py-4 text-sm text-[var(--aime-text-tertiary)]">
              {t(($) => $.worker_page.detail.no_current_task)}
            </p>
          )}
        </section>

        <section>
          <SectionTitle>{t(($) => $.worker_page.detail.skills)}</SectionTitle>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {row.agent.skills.length > 0 ? (
              row.agent.skills.slice(0, 8).map((skill) => (
                <span
                  key={skill.id}
                  className="rounded-lg bg-[var(--aime-surface-muted)] px-2 py-1 text-xs font-medium text-[var(--aime-text-secondary)]"
                >
                  {skill.name}
                </span>
              ))
            ) : (
              <span className="text-sm text-[var(--aime-text-tertiary)]">
                {t(($) => $.worker_page.detail.no_skills)}
              </span>
            )}
          </div>
        </section>

        <section>
          <SectionTitle>{t(($) => $.worker_page.detail.today_performance)}</SectionTitle>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MiniStat label={t(($) => $.worker_page.detail.today_runs)} value={`${row.todayRuns}`} />
            <MiniStat label={t(($) => $.worker_page.detail.avg_duration)} value={row.avgDurationLabel} />
            <MiniStat label={t(($) => $.worker_page.detail.success_rate)} value={formatPercent(row.successRate, t)} />
            <MiniStat label={t(($) => $.worker_page.detail.run_count_30d)} value={`${row.runCount}`} />
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <SectionTitle>{t(($) => $.worker_page.detail.recent_runs)}</SectionTitle>
            {row.activity && (
              <Sparkline
                buckets={summarizeActivityWindow(row.activity, 7).buckets}
                width={64}
                height={20}
              />
            )}
          </div>
          <div className="mt-3 divide-y divide-[var(--aime-border)]">
            {row.recentTasks.length > 0 ? (
              row.recentTasks.map((task) => (
                <div key={task.id} className="flex items-center gap-3 py-2.5">
                  <TaskStatusBadge status={task.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[var(--aime-text)]">
                      {describeTask(task, t)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--aime-text-tertiary)]">
                      {formatTaskAge(task, t)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="py-3 text-sm text-[var(--aime-text-tertiary)]">
                {t(($) => $.worker_page.detail.no_recent_runs)}
              </p>
            )}
          </div>
        </section>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-2 border-t border-[var(--aime-border)] p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenDetail(row.agent)}
          className="border-[var(--aime-border-strong)] bg-[var(--aime-surface)]"
        >
          {t(($) => $.worker_page.detail.view_log)}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenDetail(row.agent)}
          className="border-[var(--aime-border-strong)] bg-[var(--aime-surface)]"
        >
          {t(($) => $.worker_page.detail.configure)}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onAssignTask(row.agent)}
          className="border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
        >
          {t(($) => $.worker_page.detail.assign_task)}
        </Button>
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-sm font-semibold tracking-normal text-[var(--aime-text)]">
      {children}
    </h4>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--aime-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--aime-text-tertiary)]">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--aime-text)]">
        {value}
      </p>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: AgentTask["status"] }) {
  const { t } = useT("agents");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        status === "completed" && "bg-[var(--aime-success-bg)] text-[var(--aime-success)]",
        status === "failed" && "bg-[var(--aime-danger-bg)] text-[var(--aime-danger)]",
        status === "cancelled" && "bg-[var(--aime-warning-bg)] text-[var(--aime-warning)]",
        ACTIVE_TASK_STATUS.has(status) && "bg-[var(--aime-brand-50)] text-[var(--aime-brand-600)]",
      )}
    >
      {t(($) => $.worker_page.task_status[status])}
    </span>
  );
}

function TaskStatusDot({ status }: { status: AgentTask["status"] }) {
  return (
    <span
      className={cn(
        "size-1.5 rounded-full",
        status === "completed" && "bg-[var(--aime-success)]",
        status === "failed" && "bg-[var(--aime-danger)]",
        status === "cancelled" && "bg-[var(--aime-warning)]",
        ACTIVE_TASK_STATUS.has(status) && "bg-[var(--aime-brand-500)]",
      )}
    />
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useT("agents");
  return (
    <div className="flex max-w-md flex-col items-center rounded-2xl border border-[var(--aime-border)] bg-[var(--aime-surface)] px-8 py-10 text-center shadow-[var(--aime-shadow-xs)]">
      <div className="flex size-12 items-center justify-center rounded-xl bg-[var(--aime-brand-50)] text-[var(--aime-brand-600)]">
        <Bot className="size-6" />
      </div>
      <h2 className="mt-4 text-base font-semibold">{t(($) => $.empty.title)}</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--aime-text-secondary)]">
        {t(($) => $.empty.description)}
      </p>
      <Button
        type="button"
        onClick={onCreate}
        size="sm"
        className="mt-5 border-[var(--aime-brand-500)] bg-[var(--aime-brand-500)] text-white hover:bg-[var(--aime-brand-600)]"
      >
        <Plus className="size-3.5" />
        {t(($) => $.worker_page.add_worker)}
      </Button>
    </div>
  );
}

function NoMatches({ view, search }: { view: View; search: string }) {
  const { t } = useT("agents");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-center text-[var(--aime-text-tertiary)]">
      <Search className="size-8 opacity-50" />
      <p className="text-sm font-medium text-[var(--aime-text)]">
        {t(($) => $.no_matches.title)}
      </p>
      <p className="max-w-xs text-xs leading-5">
        {view === "archived"
          ? search
            ? t(($) => $.no_matches.search_archived, { query: search })
            : t(($) => $.no_matches.no_archived)
          : search
            ? t(($) => $.no_matches.search_active, { query: search })
            : t(($) => $.no_matches.no_filter_match)}
      </p>
    </div>
  );
}

function buildMetrics(rows: WorkerRow[], t: ReturnType<typeof useT<"agents">>["t"]): Metric[] {
  let online = 0;
  let running = 0;
  let todayDone = 0;
  let attention = 0;
  let sevenDayRuns = 0;
  let sevenDayFailed = 0;

  for (const row of rows) {
    if (row.presence?.availability === "online") online += 1;
    running += row.presence?.runningCount ?? 0;
    todayDone += row.todayRuns;
    const sevenDay = summarizeActivityWindow(row.activity ?? undefined, 7);
    sevenDayRuns += sevenDay.totalRuns;
    sevenDayFailed += sevenDay.totalFailed;
    if (
      row.presence?.availability === "offline" ||
      row.presence?.availability === "unstable" ||
      row.presence?.workload === "queued" ||
      sevenDay.totalFailed > 0
    ) {
      attention += 1;
    }
  }

  const success =
    sevenDayRuns > 0
      ? Math.round(((sevenDayRuns - sevenDayFailed) / sevenDayRuns) * 100)
      : null;

  return [
    {
      key: "online",
      label: t(($) => $.worker_page.metrics.online),
      value: `${online}`,
      sub: t(($) => $.worker_page.metrics.total_workers, { count: rows.length }),
      tone: "brand",
    },
    {
      key: "today",
      label: t(($) => $.worker_page.metrics.completed_today),
      value: `${todayDone}`,
      sub: success === null
        ? t(($) => $.worker_page.metrics.no_success_rate)
        : t(($) => $.worker_page.metrics.success_rate, { percent: success }),
      tone: "success",
    },
    {
      key: "running",
      label: t(($) => $.worker_page.metrics.running),
      value: `${running}`,
      sub: t(($) => $.worker_page.metrics.real_time),
      tone: "info",
    },
    {
      key: "cost",
      label: t(($) => $.worker_page.metrics.cost_today),
      value: t(($) => $.worker_page.metrics.cost_pending_value),
      sub: t(($) => $.worker_page.metrics.cost_pending_hint),
      tone: "warning",
    },
    {
      key: "attention",
      label: t(($) => $.worker_page.metrics.attention),
      value: `${attention}`,
      sub: t(($) => $.worker_page.metrics.attention_hint),
      tone: "danger",
    },
  ];
}

function metricToneClass(tone: Metric["tone"]) {
  switch (tone) {
    case "brand":
      return "text-[var(--aime-brand-600)]";
    case "success":
      return "text-[var(--aime-success)]";
    case "info":
      return "text-[var(--aime-info)]";
    case "warning":
      return "text-[var(--aime-warning)]";
    case "danger":
      return "text-[var(--aime-danger)]";
  }
}

function providerToTab(provider: string): Exclude<WorkerTab, "all"> {
  const normalized = provider.toLowerCase();
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude";
  return "other";
}

function providerLabel(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("claude")) return "Claude Code";
  if (normalized === "unknown") return "Runtime";
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pickCurrentTask(tasks: AgentTask[]): AgentTask | null {
  const active = tasks.filter((task) => ACTIVE_TASK_STATUS.has(task.status));
  if (active.length === 0) return null;
  return active.sort((a, b) => activeTaskRank(a) - activeTaskRank(b) || taskTime(b) - taskTime(a))[0] ?? null;
}

function activeTaskRank(task: AgentTask): number {
  switch (task.status) {
    case "running":
      return 0;
    case "dispatched":
      return 1;
    case "queued":
      return 2;
    default:
      return 3;
  }
}

function taskTime(task: AgentTask): number {
  const value =
    task.completed_at ??
    task.started_at ??
    task.dispatched_at ??
    task.created_at;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function describeTask(task: AgentTask, t: ReturnType<typeof useT<"agents">>["t"]): string {
  if (task.trigger_summary) return task.trigger_summary;
  if (task.issue_id) {
    return t(($) => $.worker_page.task_issue_short, {
      id: shortId(task.issue_id),
    });
  }
  if (task.chat_session_id) return t(($) => $.tab_body.activity.source_chat_session);
  if (task.autopilot_run_id) return t(($) => $.tab_body.activity.source_autopilot_run);
  if (task.kind === "quick_create") return t(($) => $.tab_body.activity.source_quick_create);
  return t(($) => $.worker_page.task_short, { id: shortId(task.id) });
}

function workDirLabel(
  agent: Agent,
  currentTask: AgentTask | null,
  t: ReturnType<typeof useT<"agents">>["t"],
): string {
  if (currentTask?.work_dir) return compactPath(currentTask.work_dir);
  if (agent.default_code_context?.type === "local_path") {
    return compactPath(agent.default_code_context.path);
  }
  return t(($) => $.worker_page.default_workspace);
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

function formatAverageDuration(
  tasks: AgentTask[],
  t: ReturnType<typeof useT<"agents">>["t"],
): string {
  const durations = tasks
    .filter((task) => task.started_at && task.completed_at)
    .map((task) => new Date(task.completed_at!).getTime() - new Date(task.started_at!).getTime())
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  if (durations.length === 0) return t(($) => $.worker_page.not_available);
  const avg = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  return formatDuration(avg, t);
}

function formatDuration(ms: number, t: ReturnType<typeof useT<"agents">>["t"]): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return t(($) => $.worker_page.duration_minutes, { count: minutes });
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) return t(($) => $.worker_page.duration_hours, { count: hours });
  return t(($) => $.worker_page.duration_hours_minutes, {
    hours,
    minutes: remaining,
  });
}

function formatPercent(
  value: number | null,
  t: ReturnType<typeof useT<"agents">>["t"],
): string {
  return value === null ? t(($) => $.worker_page.not_available) : `${value}%`;
}

function formatTaskAge(task: AgentTask, t: ReturnType<typeof useT<"agents">>["t"]): string {
  const ageMs = Date.now() - taskTime(task);
  const minutes = Math.max(1, Math.round(ageMs / 60000));
  if (minutes < 60) return t(($) => $.worker_page.ago_minutes, { count: minutes });
  const hours = Math.round(minutes / 60);
  return t(($) => $.worker_page.ago_hours, { count: hours });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
