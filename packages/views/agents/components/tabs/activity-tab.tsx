"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentTask,
  Issue,
} from "@multica/core/types";
import {
  type AgentActivity,
  agentTaskSnapshotOptions,
  agentTasksOptions,
  summarizeActivityWindow,
  useWorkspaceActivityMap,
} from "@multica/core/agents";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueDetailOptions } from "@multica/core/issues/queries";
import {
  AgentTaskRunList,
  type AgentTaskRunCopy,
} from "../../../common/agent-task-runs";
import { Sparkline } from "../sparkline";
import { useT } from "../../../i18n";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// Recent work pagination: small initial cohort to keep the section
// scannable, then "Show more" reveals 20 at a time. Tasks are already
// fully cached client-side (one listAgentTasks for the whole agent), so
// "more" is a pure state flip — zero extra fetches.
const RECENT_INITIAL = 5;
const RECENT_PAGE = 20;

interface ActivityTabProps {
  agent: Agent;
}

/**
 * Right-pane Activity tab on the agent detail page. Three sections framed
 * around the user's three diagnostic questions, in scan order:
 *
 *   Now           — what's it doing right this second?
 *   Last 7 days   — how has it been doing in aggregate?
 *   Recent work   — what did it just finish?
 *
 * All three read from caches the rest of the page already fills (the
 * workspace task snapshot for "Now", per-agent task list for "Recent",
 * the workspace 7d activity buckets for the trend), so opening this tab
 * adds no extra fetches once the page is hydrated.
 */
export function ActivityTab({ agent }: ActivityTabProps) {
  const wsId = useWorkspaceId();

  const { data: snapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));
  const { data: agentTasks = [] } = useQuery(agentTasksOptions(wsId, agent.id));
  const { byAgent: activityMap } = useWorkspaceActivityMap(wsId);
  const activity = activityMap.get(agent.id);

  const [recentDisplayLimit, setRecentDisplayLimit] = useState(RECENT_INITIAL);

  // Chat tasks are intentionally hidden across every Agent-scoped surface
  // (list / detail / activity). They have their own UI in the chat
  // experience; mixing them in here muddies "what is this agent doing
  // for the team" with "what is this agent doing in private chat".
  const isWorkflowTask = (t: AgentTask) => !t.chat_session_id;

  const activeTasks = useMemo(() => {
    return snapshot.filter(
      (t) =>
        t.agent_id === agent.id &&
        isWorkflowTask(t) &&
        (t.status === "running" ||
          t.status === "queued" ||
          t.status === "dispatched"),
    );
  }, [snapshot, agent.id]);

  // Most recent terminal tasks. Includes cancelled — users searching
  // "what just happened" want to see cancellations alongside completions
  // and failures. Chat sessions filtered out for the same reason as above.
  const recentTasksAll = useMemo(() => {
    return [...agentTasks]
      .filter(
        (t) =>
          isWorkflowTask(t) &&
          !!t.completed_at &&
          (t.status === "completed" ||
            t.status === "failed" ||
            t.status === "cancelled"),
      )
      .sort(
        (a, b) =>
          new Date(b.completed_at!).getTime() -
          new Date(a.completed_at!).getTime(),
      );
  }, [agentTasks]);

  const recentTasks = useMemo(
    () => recentTasksAll.slice(0, recentDisplayLimit),
    [recentTasksAll, recentDisplayLimit],
  );
  const hasMoreRecent = recentTasksAll.length > recentTasks.length;

  const avgDurationMs = useMemo(
    () => deriveAvgDurationLast30d(agentTasks, Date.now()),
    [agentTasks],
  );

  // Resolve issue identifiers + titles for any task we'll render. Going
  // through `issueDetailOptions` is the same lookup the rest of the app
  // uses, so the cache is shared and we don't pay for a duplicate request.
  const displayedTasks = useMemo(
    () => [...activeTasks, ...recentTasks],
    [activeTasks, recentTasks],
  );
  const issueIds = useMemo(
    () =>
      Array.from(
        new Set(displayedTasks.map((t) => t.issue_id).filter((id) => id !== "")),
      ),
    [displayedTasks],
  );
  const issueQueries = useQueries({
    queries: issueIds.map((id) => issueDetailOptions(wsId, id)),
  });
  const issueMap = useMemo(() => {
    const m = new Map<string, Issue>();
    issueQueries.forEach((q, i) => {
      const id = issueIds[i]!;
      if (q.data) m.set(id, q.data);
    });
    return m;
  }, [issueQueries, issueIds]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <NowSection tasks={activeTasks} issueMap={issueMap} agent={agent} />
      <Last30dSection activity={activity} avgDurationMs={avgDurationMs} />
      <RecentWorkSection
        tasks={recentTasks}
        totalCount={recentTasksAll.length}
        hasMore={hasMoreRecent}
        onShowMore={() =>
          setRecentDisplayLimit((n) => n + RECENT_PAGE)
        }
        issueMap={issueMap}
        agent={agent}
      />
    </div>
  );
}

function NowSection({
  tasks,
  issueMap,
  agent,
}: {
  tasks: AgentTask[];
  issueMap: Map<string, Issue>;
  agent: Agent;
}) {
  const { t } = useT("agents");
  return (
    <Section
      title={t(($) => $.tab_body.activity.section_now)}
      subtitle={
        tasks.length === 0
          ? t(($) => $.tab_body.activity.subtitle_no_active)
          : t(($) => $.tab_body.activity.subtitle_active, { count: tasks.length })
      }
    >
      {tasks.length === 0 ? (
        <EmptyText>{t(($) => $.tab_body.activity.empty_now)}</EmptyText>
      ) : (
        <TaskList
          tasks={tasks}
          issueMap={issueMap}
          timeMode="active"
          agent={agent}
        />
      )}
    </Section>
  );
}

function Last30dSection({
  activity,
  avgDurationMs,
}: {
  activity: AgentActivity | undefined;
  avgDurationMs: number;
}) {
  const { t } = useT("agents");
  const summary = summarizeActivityWindow(activity, 30);
  const { totalRuns, totalFailed } = summary;
  const successPct =
    totalRuns > 0
      ? Math.round(((totalRuns - totalFailed) / totalRuns) * 100)
      : 100;

  return (
    <Section title={t(($) => $.tab_body.activity.section_last_30d)} subtitle={t(($) => $.tab_body.activity.subtitle_performance)}>
      {totalRuns === 0 ? (
        <EmptyText>{t(($) => $.tab_body.activity.empty_30d)}</EmptyText>
      ) : (
        <div className="flex items-end justify-between gap-5">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold leading-none tabular-nums">
                {totalRuns}
              </span>
              <span className="text-sm text-muted-foreground">
                {t(($) => $.tab_body.activity.runs, { count: totalRuns })}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {t(($) => $.tab_body.activity.success_pct, { percent: successPct })}
              {avgDurationMs > 0 && (
                <>
                  <Sep />
                  <span>{t(($) => $.tab_body.activity.avg_duration, { value: formatDurationMs(avgDurationMs) })}</span>
                </>
              )}
              {totalFailed > 0 && (
                <>
                  <Sep />
                  <span className="text-destructive">
                    {t(($) => $.tab_body.activity.failed_count, { count: totalFailed })}
                  </span>
                </>
              )}
            </div>
          </div>
          {/* Garnish, not hero — small enough that a sparse 30-day series
              doesn't read as visually broken. Bottom-aligned with the
              number so the dense end of the bars sits on the same
              baseline as the digits. */}
          <Sparkline
            buckets={summary.buckets}
            width={120}
            height={32}
            className="shrink-0"
          />
        </div>
      )}
    </Section>
  );
}

function RecentWorkSection({
  tasks,
  totalCount,
  hasMore,
  onShowMore,
  issueMap,
  agent,
}: {
  tasks: AgentTask[];
  totalCount: number;
  hasMore: boolean;
  onShowMore: () => void;
  issueMap: Map<string, Issue>;
  agent: Agent;
}) {
  const { t } = useT("agents");
  const subtitle =
    tasks.length === 0
      ? t(($) => $.tab_body.activity.subtitle_no_recent)
      : totalCount > tasks.length
        ? t(($) => $.tab_body.activity.subtitle_recent_progress, { shown: tasks.length, total: totalCount })
        : t(($) => $.tab_body.activity.subtitle_recent_latest, { count: tasks.length });
  return (
    <Section title={t(($) => $.tab_body.activity.section_recent)} subtitle={subtitle}>
      {tasks.length === 0 ? (
        <EmptyText>{t(($) => $.tab_body.activity.empty_recent)}</EmptyText>
      ) : (
        <>
          <TaskList
            tasks={tasks}
            issueMap={issueMap}
            timeMode="completed"
            agent={agent}
          />
          {hasMore && (
            <button
              type="button"
              onClick={onShowMore}
              className="mt-2 self-start rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t(($) => $.tab_body.activity.show_more)}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

function TaskList({
  tasks,
  issueMap,
  timeMode,
  agent,
}: {
  tasks: AgentTask[];
  issueMap: Map<string, Issue>;
  timeMode: "active" | "completed";
  agent: Agent;
}) {
  const { t } = useT("agents");
  const paths = useWorkspacePaths();
  const copy = useMemo(() => agentActivityRunCopy(t), [t]);

  return (
    <AgentTaskRunList
      tasks={tasks}
      allowCancel={timeMode === "active"}
      allowRetry={false}
      className="space-y-1.5"
      collapsePast={false}
      copy={copy}
      getAgentName={() => agent.name}
      getTaskHref={(task) =>
        task.issue_id ? paths.issueDetail(task.issue_id) : undefined
      }
      getTriggerText={(task, fallback) =>
        agentActivityTaskTitle(task, issueMap, t) ?? fallback
      }
      onCancelTask={(task) => api.cancelTaskById(task.id)}
      renderTaskPrefix={(task) => {
        const issue = task.issue_id ? issueMap.get(task.issue_id) : null;
        if (!issue) return null;
        return (
          <span className="mr-1 font-mono text-[11px] text-muted-foreground/80">
            {issue.identifier}
          </span>
        );
      }}
      showAvatar={false}
    />
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-background p-5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        <span className="text-[11px] text-muted-foreground/70">{subtitle}</span>
      </div>
      {children}
    </section>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="text-xs italic text-muted-foreground/60">{children}</p>;
}

function Sep() {
  // mx-1 puts visible whitespace around the dot; without it inline JSX
  // collapses neighbouring tokens to "100% success·avg 30s" which reads
  // as "successdotavg" at a glance.
  return <span className="mx-1 text-muted-foreground/40">·</span>;
}

type AgentsT = ReturnType<typeof useT<"agents">>["t"];

function agentActivityRunCopy(t: AgentsT): Partial<AgentTaskRunCopy> {
  return {
    openTaskAria: t(($) => $.tab_body.activity.open_issue_aria),
    openTaskTooltip: t(($) => $.tab_body.activity.open_issue_tooltip),
    transcriptTooltip: t(($) => $.tab_body.activity.transcript_tooltip),
    cancelTaskAria: t(($) => $.tab_body.activity.cancel_task_aria),
    cancelTaskTooltip: t(($) => $.tab_body.activity.cancel_task_tooltip),
    cancelFailed: t(($) => $.tab_body.activity.cancel_failed_toast),
    status: {
      queued: t(($) => $.worker_page.task_status.queued),
      dispatched: t(($) => $.worker_page.task_status.dispatched),
      running: t(($) => $.worker_page.task_status.running),
      completed: t(($) => $.worker_page.task_status.completed),
      failed: t(($) => $.worker_page.task_status.failed),
      cancelled: t(($) => $.worker_page.task_status.cancelled),
    },
  };
}

function agentActivityTaskTitle(
  task: AgentTask,
  issueMap: Map<string, Issue>,
  t: AgentsT,
): string {
  const hasIssue = task.issue_id !== "";
  const issue = hasIssue ? issueMap.get(task.issue_id) : undefined;
  if (issue?.title) return issue.title;
  if (hasIssue) {
    return t(($) => $.tab_body.activity.issue_short_fallback, {
      prefix: task.issue_id.slice(0, 8),
    });
  }
  return agentActivitySourceFallback(task, t);
}

function agentActivitySourceFallback(task: AgentTask, t: AgentsT): string {
  if (task.kind === "quick_create") {
    return isTerminalTask(task)
      ? t(($) => $.tab_body.activity.source_quick_create)
      : t(($) => $.tab_body.activity.source_creating_issue);
  }
  if (task.chat_session_id) return t(($) => $.tab_body.activity.source_chat_session);
  if (task.autopilot_run_id) return t(($) => $.tab_body.activity.source_autopilot_run);
  return t(($) => $.tab_body.activity.source_untracked);
}

function isTerminalTask(task: AgentTask): boolean {
  return (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

/**
 * Average wall-clock duration of completed/failed tasks whose completion
 * lands in the last 30 days. Pure function so callers can pass a
 * deterministic `now` in tests.
 */
export function deriveAvgDurationLast30d(
  tasks: readonly AgentTask[],
  now: number,
): number {
  let sum = 0;
  let count = 0;
  for (const t of tasks) {
    if (!t.completed_at || !t.started_at) continue;
    const completedAt = new Date(t.completed_at).getTime();
    if (Number.isNaN(completedAt)) continue;
    if (now - completedAt > THIRTY_DAYS_MS) continue;
    const startedAt = new Date(t.started_at).getTime();
    const dur = completedAt - startedAt;
    if (Number.isFinite(dur) && dur > 0) {
      sum += dur;
      count += 1;
    }
  }
  return count > 0 ? Math.round(sum / count) : 0;
}

/**
 * Compact human-readable duration ("12s", "2m 04s", "1h 30m"). Pads the
 * seconds inside the minute formatter so the column stays visually
 * aligned across rows.
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 60_000) {
    return `${Math.max(1, Math.round(ms / 1000))}s`;
  }
  if (ms < 60 * 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(ms / (60 * 60_000));
  const m = Math.floor((ms % (60 * 60_000)) / 60_000);
  return `${h}h ${m}m`;
}
