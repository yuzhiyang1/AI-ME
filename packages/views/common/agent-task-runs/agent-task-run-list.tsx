"use client";

import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  Loader2,
  RotateCcw,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import type { AgentTask, TaskFailureReason } from "@multica/core/types";
import { timeAgo } from "@multica/core/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { ActorAvatar } from "../actor-avatar";
import { TranscriptButton } from "../task-transcript";
import { AppLink } from "../../navigation";
import { failureReasonLabel } from "../../agents/components/tabs/task-failure";
import { splitAgentTaskRuns } from "./task-run-utils";

export interface AgentTaskRunCopy {
  showPast: (count: number) => string;
  hidePast: (count: number) => string;
  transcriptTooltip: string;
  openTaskAria: string;
  openTaskTooltip: string;
  cancelTaskAria: string;
  cancelTaskTooltip: string;
  cancelFailed: string;
  retryTaskAria: string;
  retryTaskTooltip: string;
  retryFailed: string;
  emptyTitle: string;
  emptyDescription: string;
  status: Record<AgentTask["status"], string>;
  trigger: {
    retryAttemptPrefix: (attempt: number) => string;
    retryPrefix: string;
    retryAttempt: (attempt: number) => string;
    retry: string;
    autopilot: string;
    comment: string;
    initial: string;
  };
}

interface AgentTaskRunListProps {
  tasks: AgentTask[];
  issueId?: string;
  className?: string;
  initialShowPast?: boolean;
  showEmpty?: boolean;
  empty?: ReactNode;
  allowCancel?: boolean;
  allowRetry?: boolean;
  collapsePast?: boolean;
  copy?: Partial<AgentTaskRunCopy>;
  getAgentName?: (task: AgentTask) => string;
  getTaskHref?: (task: AgentTask) => string | undefined;
  getTriggerText?: (task: AgentTask, fallback: string) => string;
  onCancelTask?: (task: AgentTask) => Promise<unknown>;
  renderTaskPrefix?: (task: AgentTask) => ReactNode;
  showAvatar?: boolean;
}

const DEFAULT_COPY: AgentTaskRunCopy = {
  showPast: (count) => `Show past runs (${count})`,
  hidePast: (count) => `Hide past runs (${count})`,
  transcriptTooltip: "View transcript",
  openTaskAria: "Open task",
  openTaskTooltip: "Open task",
  cancelTaskAria: "Cancel task",
  cancelTaskTooltip: "Cancel task",
  cancelFailed: "Failed to cancel task",
  retryTaskAria: "Retry task",
  retryTaskTooltip: "Retry task",
  retryFailed: "Failed to retry task",
  emptyTitle: "No agent runs",
  emptyDescription: "Agent execution records will appear here.",
  status: {
    queued: "Queued",
    dispatched: "Dispatched",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  trigger: {
    retryAttemptPrefix: (attempt) => `Retry #${attempt} · `,
    retryPrefix: "Retry · ",
    retryAttempt: (attempt) => `Retry #${attempt}`,
    retry: "Retry",
    autopilot: "Autopilot",
    comment: "From comment",
    initial: "Initial assignment",
  },
};

const TRIGGER_MASK_STYLE: CSSProperties = {
  maskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
  WebkitMaskImage:
    "linear-gradient(to right, black calc(100% - 12px), transparent)",
};

const STATUS_TONE: Record<AgentTask["status"], string> = {
  queued: "text-warning",
  dispatched: "text-warning",
  running: "text-info",
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

export function AgentTaskRunList({
  tasks,
  issueId,
  className,
  initialShowPast = false,
  showEmpty = false,
  empty,
  allowCancel = true,
  allowRetry = true,
  collapsePast = true,
  copy,
  getAgentName,
  getTaskHref,
  getTriggerText,
  onCancelTask,
  renderTaskPrefix,
  showAvatar = true,
}: AgentTaskRunListProps) {
  const [showPast, setShowPast] = useState(initialShowPast);
  const labels = useMergedCopy(copy);
  const { activeTasks, pastTasks } = useMemo(
    () => splitAgentTaskRuns(tasks),
    [tasks],
  );

  if (activeTasks.length === 0 && pastTasks.length === 0) {
    if (empty) return <>{empty}</>;
    if (!showEmpty) return null;
    return (
      <div className={className}>
        <p className="text-xs font-medium text-muted-foreground">
          {labels.emptyTitle}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {labels.emptyDescription}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      {activeTasks.map((task) => (
        <ActiveRunRow
          key={task.id}
          task={task}
          issueId={issueId}
          copy={labels}
          canCancel={allowCancel && (!!issueId || !!onCancelTask)}
          agentName={getAgentName?.(task) ?? ""}
          href={getTaskHref?.(task)}
          onCancelTask={onCancelTask}
          prefix={renderTaskPrefix?.(task)}
          showAvatar={showAvatar}
          triggerText={getTriggerText}
        />
      ))}

      {pastTasks.length > 0 && (
        <>
          {activeTasks.length > 0 && (
            <div className="my-1.5 border-t border-border/60" />
          )}
          {collapsePast ? (
            <button
              type="button"
              onClick={() => setShowPast(!showPast)}
              className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <ChevronRight
                className={`!size-3 shrink-0 stroke-[2.5] transition-transform ${
                  showPast ? "rotate-90" : ""
                }`}
              />
              {showPast ? labels.hidePast(pastTasks.length) : labels.showPast(pastTasks.length)}
            </button>
          ) : null}
          {(!collapsePast || showPast) && (
            <div className="mt-0.5 space-y-0.5">
              {pastTasks.map((task) => (
                <PastRunRow
                  key={task.id}
                  task={task}
                  issueId={issueId}
                  copy={labels}
                  canRetry={allowRetry && !!issueId}
                  agentName={getAgentName?.(task) ?? ""}
                  href={getTaskHref?.(task)}
                  prefix={renderTaskPrefix?.(task)}
                  showAvatar={showAvatar}
                  triggerText={getTriggerText}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function useMergedCopy(copy: Partial<AgentTaskRunCopy> | undefined): AgentTaskRunCopy {
  return useMemo(
    () => ({
      ...DEFAULT_COPY,
      ...copy,
      status: { ...DEFAULT_COPY.status, ...copy?.status },
      trigger: { ...DEFAULT_COPY.trigger, ...copy?.trigger },
    }),
    [copy],
  );
}

function ActiveRunRow({
  task,
  issueId,
  copy,
  canCancel,
  agentName,
  href,
  onCancelTask,
  prefix,
  showAvatar,
  triggerText,
}: {
  task: AgentTask;
  issueId?: string;
  copy: AgentTaskRunCopy;
  canCancel: boolean;
  agentName: string;
  href?: string;
  onCancelTask?: (task: AgentTask) => Promise<unknown>;
  prefix?: ReactNode;
  showAvatar: boolean;
  triggerText?: (task: AgentTask, fallback: string) => string;
}) {
  const [cancelling, setCancelling] = useState(false);
  const triggerFallback = taskTriggerText(task, copy);
  const trigger = triggerText?.(task, triggerFallback) ?? triggerFallback;
  const time = activeTimeText(task);
  const showTranscript = task.status !== "queued";

  const handleCancel = async () => {
    if (cancelling || (!issueId && !onCancelTask)) return;
    setCancelling(true);
    try {
      if (onCancelTask) {
        await onCancelTask(task);
      } else if (issueId) {
        await api.cancelTask(issueId, task.id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : copy.cancelFailed);
      setCancelling(false);
    }
  };

  return (
    <RunRowShell task={task} showAvatar={showAvatar}>
      <TriggerText text={trigger} prefix={prefix} />
      <TaskStatusText task={task} copy={copy} time={time} />
      <RowActions>
        {href && (
          <OpenTaskLink href={href} copy={copy} />
        )}
        {showTranscript && (
          <TranscriptButton
            task={task}
            agentName={agentName}
            isLive
            title={copy.transcriptTooltip}
          />
        )}
        {canCancel && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                  aria-label={copy.cancelTaskAria}
                />
              }
              className="flex items-center justify-center rounded p-1 text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>{copy.cancelTaskTooltip}</TooltipContent>
          </Tooltip>
        )}
      </RowActions>
    </RunRowShell>
  );
}

function PastRunRow({
  task,
  issueId,
  copy,
  canRetry,
  agentName,
  href,
  prefix,
  showAvatar,
  triggerText,
}: {
  task: AgentTask;
  issueId?: string;
  copy: AgentTaskRunCopy;
  canRetry: boolean;
  agentName: string;
  href?: string;
  prefix?: ReactNode;
  showAvatar: boolean;
  triggerText?: (task: AgentTask, fallback: string) => string;
}) {
  const [retrying, setRetrying] = useState(false);
  const triggerFallback = taskTriggerText(task, copy);
  const trigger = triggerText?.(task, triggerFallback) ?? triggerFallback;
  const time = task.completed_at ? timeAgo(task.completed_at) : "--";
  const failureLabel =
    task.status === "failed" && task.failure_reason
      ? failureReasonLabel[task.failure_reason as TaskFailureReason]
      : null;

  const handleRetry = async () => {
    if (retrying || !issueId) return;
    setRetrying(true);
    try {
      await api.rerunIssue(issueId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : copy.retryFailed);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <RunRowShell task={task} showAvatar={showAvatar}>
      <TriggerText text={trigger} prefix={prefix} />
      <TaskStatusText
        task={task}
        copy={copy}
        time={time}
        labelOverride={failureLabel}
      />
      <RowActions>
        {href && (
          <OpenTaskLink href={href} copy={copy} />
        )}
        <TranscriptButton
          task={task}
          agentName={agentName}
          title={copy.transcriptTooltip}
        />
        {canRetry && (task.status === "failed" || task.status === "cancelled") && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={retrying}
                  aria-label={copy.retryTaskAria}
                />
              }
              className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {retrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>{copy.retryTaskTooltip}</TooltipContent>
          </Tooltip>
        )}
      </RowActions>
    </RunRowShell>
  );
}

function RunRowShell({
  task,
  children,
  showAvatar,
}: {
  task: AgentTask;
  children: ReactNode;
  showAvatar: boolean;
}) {
  return (
    <div className="group relative flex items-center gap-2 rounded px-1 py-1.5 transition-colors hover:bg-accent/40">
      {showAvatar && task.agent_id ? (
        <ActorAvatar
          actorType="agent"
          actorId={task.agent_id}
          size={20}
          enableHoverCard
        />
      ) : showAvatar ? (
        <span className="inline-block h-5 w-5 shrink-0 rounded-full bg-muted" />
      ) : null}
      {children}
    </div>
  );
}

function TriggerText({
  text,
  prefix,
}: {
  text: string;
  prefix?: ReactNode;
}) {
  return (
    <span
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
      style={TRIGGER_MASK_STYLE}
    >
      {prefix}
      {text}
    </span>
  );
}

function OpenTaskLink({
  href,
  copy,
}: {
  href: string;
  copy: AgentTaskRunCopy;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<AppLink href={href} />}
        aria-label={copy.openTaskAria}
        className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent>{copy.openTaskTooltip}</TooltipContent>
    </Tooltip>
  );
}

function TaskStatusText({
  task,
  copy,
  time,
  labelOverride,
}: {
  task: AgentTask;
  copy: AgentTaskRunCopy;
  time: string;
  labelOverride?: string | null;
}) {
  return (
    <span className="shrink-0 whitespace-nowrap text-xs">
      <span className={STATUS_TONE[task.status]}>{labelOverride ?? copy.status[task.status]}</span>
      <span className="text-muted-foreground"> · {time}</span>
    </span>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <div
      className={[
        "pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 pl-6 opacity-0 transition-opacity",
        "bg-gradient-to-l from-accent/95 via-accent/80 to-transparent",
        "group-hover:pointer-events-auto group-hover:opacity-100",
        "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function activeTimeText(task: AgentTask): string {
  if (task.status === "running" && task.started_at) {
    return timeAgo(task.started_at);
  }
  if (task.status === "dispatched" && task.dispatched_at) {
    return timeAgo(task.dispatched_at);
  }
  return timeAgo(task.created_at);
}

function taskTriggerText(task: AgentTask, copy: AgentTaskRunCopy): string {
  const isRetry = !!task.parent_task_id;
  const retryPrefix = isRetry
    ? task.attempt && task.attempt > 1
      ? copy.trigger.retryAttemptPrefix(task.attempt)
      : copy.trigger.retryPrefix
    : "";

  if (task.trigger_summary) return retryPrefix + task.trigger_summary;
  if (isRetry) {
    return task.attempt && task.attempt > 1
      ? copy.trigger.retryAttempt(task.attempt)
      : copy.trigger.retry;
  }
  if (task.autopilot_run_id) return copy.trigger.autopilot;
  if (task.trigger_comment_id) return copy.trigger.comment;
  return copy.trigger.initial;
}
