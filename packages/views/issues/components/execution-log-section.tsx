"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { api } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import type { AgentTaskRunCopy } from "../../common/agent-task-runs";
import {
  AgentTaskRunList,
  countActiveAgentTasks,
  hasAgentTaskRuns,
} from "../../common/agent-task-runs";
import { useT } from "../../i18n";

interface ExecutionLogSectionProps {
  issueId: string;
}

type IssuesT = ReturnType<typeof useT<"issues">>["t"];

export function ExecutionLogSection({ issueId }: ExecutionLogSectionProps) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(true);

  // One server-state query drives both active and historical rows. The shared
  // row component only renders and triggers actions; freshness still comes from
  // this issue-scoped cache plus the global task:* websocket invalidation.
  const { data: tasks = [] } = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const activeCount = countActiveAgentTasks(tasks);
  const copy = useIssueTaskRunCopy(t);

  if (!hasAgentTaskRuns(tasks)) return null;

  return (
    <div>
      <button
        className={`mb-2 flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-accent/70 ${
          open ? "" : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.execution_log.section)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        {activeCount > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-info">
            <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse" />
            <span className="font-mono tabular-nums">{activeCount}</span>
          </span>
        )}
      </button>
      {open && (
        <AgentTaskRunList
          tasks={tasks}
          issueId={issueId}
          copy={copy}
          className="space-y-0.5 pl-2"
        />
      )}
    </div>
  );
}

function useIssueTaskRunCopy(t: IssuesT): Partial<AgentTaskRunCopy> {
  return useMemo(
    () => ({
      showPast: (count) => t(($) => $.execution_log.show_past, { count }),
      hidePast: (count) => t(($) => $.execution_log.hide_past, { count }),
      transcriptTooltip: t(($) => $.execution_log.transcript_tooltip),
      cancelTaskAria: t(($) => $.execution_log.cancel_task_aria),
      cancelTaskTooltip: t(($) => $.execution_log.cancel_task_tooltip),
      cancelFailed: t(($) => $.execution_log.cancel_failed),
      retryTaskAria: t(($) => $.execution_log.retry_task_aria),
      retryTaskTooltip: t(($) => $.execution_log.retry_task_tooltip),
      retryFailed: t(($) => $.execution_log.retry_failed),
      status: {
        queued: t(($) => $.execution_log.status_queued),
        dispatched: t(($) => $.execution_log.status_dispatched),
        running: t(($) => $.execution_log.status_running),
        completed: t(($) => $.execution_log.status_completed),
        failed: t(($) => $.execution_log.status_failed),
        cancelled: t(($) => $.execution_log.status_cancelled),
      },
      trigger: {
        retryAttemptPrefix: (attempt) =>
          t(($) => $.execution_log.trigger_retry_attempt_prefix, { attempt }),
        retryPrefix: t(($) => $.execution_log.trigger_retry_prefix),
        retryAttempt: (attempt) =>
          t(($) => $.execution_log.trigger_retry_attempt, { attempt }),
        retry: t(($) => $.execution_log.trigger_retry),
        autopilot: t(($) => $.execution_log.trigger_autopilot),
        comment: t(($) => $.execution_log.trigger_comment),
        initial: t(($) => $.execution_log.trigger_initial),
      },
    }),
    [t],
  );
}
