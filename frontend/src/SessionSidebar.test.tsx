// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { AgentSession, Project } from "./api";
import { SessionSidebar } from "./SessionSidebar";

afterEach(cleanup);

const project: Project = {
  id: "project-a",
  name: "AI-ME",
  roots: [
    { path: "D:\\workspac\\AI-ME", position: 0, primary: true },
    { path: "D:\\workspac\\maka", position: 1, primary: false },
  ],
  position: 0,
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
};

it("按项目与任务归组会话并展示各自上下文圆环", () => {
  render(
    <SessionSidebar
      projects={[project]}
      sessions={[
        session("project-session", "项目会话", project.id, 56),
        session("task-session", "独立会话", null, null),
      ]}
      activeSessionId="project-session"
      loading={false}
      onOpenSession={vi.fn()}
      onCreateProject={vi.fn()}
      onEditProject={vi.fn()}
      onDeleteProject={vi.fn()}
      onCreateSession={vi.fn()}
    />,
  );

  expect(screen.getByRole("group", { name: "项目 AI-ME" }).textContent).toContain("项目会话");
  expect(screen.getByRole("group", { name: "任务" }).textContent).toContain("独立会话");
  expect(
    screen.getByRole("progressbar", { name: "项目会话上下文占用" })
      .getAttribute("aria-valuenow"),
  ).toBe("56");
  expect(
    screen.getByRole("progressbar", { name: "独立会话上下文占用" })
      .hasAttribute("aria-valuenow"),
  ).toBe(false);
});

it("项目可收起，并从项目行创建会话或打开管理动作", async () => {
  const onCreateSession = vi.fn();
  const onEditProject = vi.fn();
  const onDeleteProject = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionSidebar
      projects={[project]}
      sessions={[session("project-session", "项目会话", project.id, 20)]}
      activeSessionId={null}
      loading={false}
      onOpenSession={vi.fn()}
      onCreateProject={vi.fn()}
      onEditProject={onEditProject}
      onDeleteProject={onDeleteProject}
      onCreateSession={onCreateSession}
    />,
  );

  await user.click(screen.getByRole("button", { name: "收起项目 AI-ME" }));
  expect(screen.queryByText("项目会话")).toBeNull();
  await user.click(screen.getByRole("button", { name: "在 AI-ME 中新建会话" }));
  await user.click(screen.getByRole("button", { name: "编辑项目 AI-ME" }));
  await user.click(screen.getByRole("button", { name: "删除项目 AI-ME" }));

  expect(onCreateSession).toHaveBeenCalledWith(project);
  expect(onEditProject).toHaveBeenCalledWith(project);
  expect(onDeleteProject).toHaveBeenCalledWith(project);
});

function session(
  id: string,
  title: string,
  projectId: string | null,
  percentage: number | null,
): AgentSession {
  return {
    id,
    title,
    projectId,
    workspacePath: "D:\\workspac\\AI-ME",
    workspaceRoots: ["D:\\workspac\\AI-ME"],
    defaultModel: "qa/model",
    permissionProfile: "workspace_write",
    lifecycle: "active",
    activity: "idle",
    pinned: false,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    contextUsage: {
      currentContextTokens: percentage === null ? null : 18_000,
      contextWindow: percentage === null ? null : 32_000,
      percentage,
      partial: percentage === null,
    },
  };
}
