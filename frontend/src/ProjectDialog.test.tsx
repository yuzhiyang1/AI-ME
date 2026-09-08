// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { Project } from "./api";
import { ProjectDialog } from "./ProjectDialog";

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

it("添加目录、设为主目录并按新顺序提交", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onChooseFolder = vi.fn().mockResolvedValue("D:\\workspac\\DeepTutor");
  const user = userEvent.setup();
  render(
    <ProjectDialog
      open
      project={project}
      onClose={vi.fn()}
      onChooseFolder={onChooseFolder}
      onSave={onSave}
    />,
  );

  await user.click(screen.getByRole("button", { name: "添加文件夹" }));
  await user.click(screen.getByRole("button", { name: "将 maka 设为主要" }));
  await user.click(screen.getByRole("button", { name: "保存项目" }));

  expect(onSave).toHaveBeenCalledWith({
    name: "AI-ME",
    roots: [
      "D:\\workspac\\maka",
      "D:\\workspac\\AI-ME",
      "D:\\workspac\\DeepTutor",
    ],
  });
});

it("保存失败时保留输入并显示错误", async () => {
  const onSave = vi.fn().mockRejectedValue(new Error("目录无法访问"));
  const user = userEvent.setup();
  render(
    <ProjectDialog
      open
      project={null}
      onClose={vi.fn()}
      onChooseFolder={vi.fn().mockResolvedValue("D:\\workspac\\AI-ME")}
      onSave={onSave}
    />,
  );

  await user.type(screen.getByRole("textbox", { name: "项目名称" }), "新项目");
  await user.click(screen.getByRole("button", { name: "添加文件夹" }));
  await user.click(screen.getByRole("button", { name: "保存项目" }));

  expect(await screen.findByText("目录无法访问")).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "项目名称" }) as HTMLInputElement).value,
  ).toBe("新项目");
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
});
