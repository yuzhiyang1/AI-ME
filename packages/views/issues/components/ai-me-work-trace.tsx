"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { api } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import type { AgentTask, AIApproval, TimelineEntry } from "@multica/core/types";
import { timeAgo } from "@multica/core/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";

interface AIMeWorkTraceProps {
  issueId: string;
  approvals: AIApproval[];
  approvalsLoading: boolean;
  approvalsError: unknown;
  timeline: TimelineEntry[];
  onOpenApproval: (approvalId: string) => void;
}

const ACTIVE_TASK_STATUSES = new Set<AgentTask["status"]>(["queued", "dispatched", "running"]);
const AI_ME_ACTIVITY_ACTIONS = new Set(["task_completed", "task_failed"]);

export function AIMeWorkTrace({
  issueId,
  approvals,
  approvalsLoading,
  approvalsError,
  timeline,
  onOpenApproval,
}: AIMeWorkTraceProps) {
  const { t } = useT("issues");
  const { getActorName, getAgentName } = useActorName();
  const [open, setOpen] = useState(true);
  const tasksQuery = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const tasks = tasksQuery.data ?? [];
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const failedApprovals = approvals.filter((approval) => approval.execution_status === "failed");
  const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const failedTasks = tasks.filter((task) => task.status === "failed");
  const traceActivities = useMemo(
    () =>
      timeline
        .filter((entry) => {
          if (entry.type !== "activity") return false;
          const details = entry.details ?? {};
          return (
            AI_ME_ACTIVITY_ACTIONS.has(entry.action ?? "") ||
            details.source === "ai_me_approval" ||
            typeof details.approval_id === "string"
          );
        })
        .slice(-4)
        .reverse(),
    [timeline],
  );

  const hasTrace = approvals.length > 0 || tasks.length > 0 || traceActivities.length > 0;
  const needsAttention = pendingApprovals.length + failedApprovals.length + failedTasks.length;

  return (
    <div>
      <button
        className={cn(
          "mb-2 flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-accent/70",
          open ? "" : "text-muted-foreground hover:text-foreground",
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <BrainCircuit className="!size-3 shrink-0 text-muted-foreground" />
        {t(($) => $.ai_me_trace.section)}
        <ChevronRight
          className={cn(
            "!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {needsAttention > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-warning">
            <AlertTriangle className="h-3 w-3" />
            <span className="font-mono tabular-nums">{needsAttention}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-xs">
          {(approvalsLoading || tasksQuery.isLoading) && !hasTrace ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : approvalsError || tasksQuery.error ? (
            <div className="flex items-start gap-2 text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t(($) => $.ai_me_trace.error)}</span>
            </div>
          ) : !hasTrace ? (
            <p className="leading-5 text-muted-foreground">
              {t(($) => $.ai_me_trace.empty)}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <TraceMetric
                  label={t(($) => $.ai_me_trace.metric_approvals)}
                  value={String(approvals.length)}
                  tone={pendingApprovals.length > 0 ? "warning" : "default"}
                />
                <TraceMetric
                  label={t(($) => $.ai_me_trace.metric_running)}
                  value={String(activeTasks.length)}
                  tone={activeTasks.length > 0 ? "info" : "default"}
                />
                <TraceMetric
                  label={t(($) => $.ai_me_trace.metric_failed)}
                  value={String(failedApprovals.length + failedTasks.length)}
                  tone={failedApprovals.length + failedTasks.length > 0 ? "danger" : "default"}
                />
              </div>

              {approvals.length > 0 && (
                <div className="space-y-1.5">
                  <TraceHeading>{t(($) => $.ai_me_trace.approvals_heading)}</TraceHeading>
                  {approvals.slice(0, 3).map((approval) => (
                    <button
                      type="button"
                      key={approval.id}
                      className="w-full rounded-md border border-border/70 bg-background p-2 text-left transition-colors hover:border-brand/40 hover:bg-brand/5"
                      onClick={() => onOpenApproval(approval.id)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {approval.title}
                        </span>
                        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5", approvalToneClass(approval))}>
                          {approvalStatusText(approval, t)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                        <span className="truncate">{approval.action_title || approval.action_type}</span>
                        <span>·</span>
                        <span>{timeAgo(approval.created_at)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {tasks.length > 0 && (
                <div className="space-y-1.5">
                  <TraceHeading>{t(($) => $.ai_me_trace.tasks_heading)}</TraceHeading>
                  {tasks.slice(0, 3).map((task) => (
                    <div key={task.id} className="rounded-md border border-border/70 bg-background p-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {task.status === "completed" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                        ) : task.status === "failed" ? (
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        ) : (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 text-info" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {getAgentName(task.agent_id)}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {taskStatusText(task.status, t)}
                        </span>
                      </div>
                      {task.error && (
                        <p className="mt-1 line-clamp-2 leading-5 text-destructive">
                          {task.error}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {traceActivities.length > 0 && (
                <div className="space-y-1.5">
                  <TraceHeading>{t(($) => $.ai_me_trace.audit_heading)}</TraceHeading>
                  <div className="space-y-1">
                    {traceActivities.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-2 text-muted-foreground">
                        <Clock3 className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {getActorName(entry.actor_type, entry.actor_id)} {activityText(entry, t)}
                        </span>
                        <span className="shrink-0">{timeAgo(entry.created_at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {approvals.length > 3 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 w-full"
                  onClick={() => onOpenApproval(approvals[0]!.id)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t(($) => $.ai_me_trace.view_all)}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TraceMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "default" | "warning" | "danger" | "info";
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-sm font-semibold tabular-nums",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-destructive",
          tone === "info" && "text-info",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function TraceHeading({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-medium text-muted-foreground">{children}</div>;
}

type IssuesT = ReturnType<typeof useT<"issues">>["t"];

function approvalStatusText(approval: AIApproval, t: IssuesT) {
  if (approval.execution_status === "failed") return t(($) => $.ai_me_trace.approval_execution_failed);
  if (approval.execution_status === "succeeded") return t(($) => $.ai_me_trace.approval_execution_succeeded);
  if (approval.status === "pending") return t(($) => $.ai_me_trace.approval_pending);
  if (approval.status === "rejected") return t(($) => $.ai_me_trace.approval_rejected);
  if (approval.status === "taken_over") return t(($) => $.ai_me_trace.approval_taken_over);
  if (approval.status === "observing") return t(($) => $.ai_me_trace.approval_observing);
  return approval.status;
}

function approvalToneClass(approval: AIApproval) {
  if (approval.execution_status === "failed") return "bg-destructive/10 text-destructive";
  if (approval.status === "pending") return "bg-warning/10 text-warning";
  if (approval.execution_status === "succeeded") return "bg-success/10 text-success";
  return "bg-muted text-muted-foreground";
}

function taskStatusText(status: AgentTask["status"], t: IssuesT) {
  switch (status) {
    case "queued":
      return t(($) => $.ai_me_trace.task_queued);
    case "dispatched":
      return t(($) => $.ai_me_trace.task_dispatched);
    case "running":
      return t(($) => $.ai_me_trace.task_running);
    case "completed":
      return t(($) => $.ai_me_trace.task_completed);
    case "failed":
      return t(($) => $.ai_me_trace.task_failed);
    case "cancelled":
      return t(($) => $.ai_me_trace.task_cancelled);
    default:
      return status;
  }
}

function activityText(entry: TimelineEntry, t: IssuesT) {
  if (entry.action === "task_completed") return t(($) => $.ai_me_trace.activity_task_completed);
  if (entry.action === "task_failed") return t(($) => $.ai_me_trace.activity_task_failed);
  if (entry.action === "assignee_changed") return t(($) => $.ai_me_trace.activity_assignee_changed);
  return entry.action ?? t(($) => $.ai_me_trace.activity_fallback);
}
