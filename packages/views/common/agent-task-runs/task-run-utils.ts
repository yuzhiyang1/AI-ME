import type { AgentTask } from "@multica/core/types";

export const ACTIVE_AGENT_TASK_STATUSES = new Set<AgentTask["status"]>([
  "queued",
  "dispatched",
  "running",
]);

const PAST_STATUS_RANK: Record<string, number> = {
  failed: 0,
  cancelled: 1,
  completed: 2,
};

export interface AgentTaskRunBuckets {
  activeTasks: AgentTask[];
  pastTasks: AgentTask[];
}

export function isActiveAgentTask(task: AgentTask): boolean {
  return ACTIVE_AGENT_TASK_STATUSES.has(task.status);
}

export function isPastAgentTask(task: AgentTask): boolean {
  return (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

export function splitAgentTaskRuns(tasks: readonly AgentTask[]): AgentTaskRunBuckets {
  const activeTasks = tasks.filter(isActiveAgentTask);
  const pastTasks = tasks
    .filter(isPastAgentTask)
    .sort((a, b) => {
      const rankDiff =
        (PAST_STATUS_RANK[a.status] ?? 99) -
        (PAST_STATUS_RANK[b.status] ?? 99);
      if (rankDiff !== 0) return rankDiff;
      const at = a.completed_at ?? a.created_at;
      const bt = b.completed_at ?? b.created_at;
      return new Date(bt).getTime() - new Date(at).getTime();
    });

  return { activeTasks, pastTasks };
}

export function countActiveAgentTasks(tasks: readonly AgentTask[]): number {
  return tasks.filter(isActiveAgentTask).length;
}

export function hasAgentTaskRuns(tasks: readonly AgentTask[]): boolean {
  return tasks.some((task) => isActiveAgentTask(task) || isPastAgentTask(task));
}
