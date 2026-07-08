import { describe, expect, it } from "vitest";
import type { AgentTask } from "@multica/core/types";
import {
  countActiveAgentTasks,
  hasAgentTaskRuns,
  splitAgentTaskRuns,
} from "./task-run-utils";

describe("agent task run utils", () => {
  it("splits active and past task runs with attention-first past sorting", () => {
    const tasks = [
      task({ id: "completed-new", status: "completed", completed_at: "2026-07-08T02:00:00.000Z" }),
      task({ id: "running", status: "running", started_at: "2026-07-08T03:00:00.000Z" }),
      task({ id: "failed-old", status: "failed", completed_at: "2026-07-08T01:00:00.000Z" }),
      task({ id: "cancelled", status: "cancelled", completed_at: "2026-07-08T04:00:00.000Z" }),
      task({ id: "failed-new", status: "failed", completed_at: "2026-07-08T05:00:00.000Z" }),
    ];

    const result = splitAgentTaskRuns(tasks);

    expect(result.activeTasks.map((item) => item.id)).toEqual(["running"]);
    expect(result.pastTasks.map((item) => item.id)).toEqual([
      "failed-new",
      "failed-old",
      "cancelled",
      "completed-new",
    ]);
    expect(countActiveAgentTasks(tasks)).toBe(1);
    expect(hasAgentTaskRuns(tasks)).toBe(true);
  });

  it("treats queued, dispatched, and running tasks as active work", () => {
    const tasks = [
      task({ id: "queued", status: "queued" }),
      task({ id: "dispatched", status: "dispatched" }),
      task({ id: "running", status: "running" }),
      task({ id: "completed", status: "completed" }),
    ];

    const result = splitAgentTaskRuns(tasks);

    expect(result.activeTasks.map((item) => item.id)).toEqual([
      "queued",
      "dispatched",
      "running",
    ]);
    expect(result.pastTasks.map((item) => item.id)).toEqual(["completed"]);
    expect(countActiveAgentTasks(tasks)).toBe(3);
    expect(hasAgentTaskRuns([])).toBe(false);
  });
});

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "task",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "queued",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}
