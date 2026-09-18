// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { listSkills } from "./api";
import { SkillLibrary } from "./SkillLibrary";

vi.mock("./api", () => ({listSkills: vi.fn(), saveSkillPreference: vi.fn()}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("按真实来源筛选并从详情选择准确 Skill 引用", async () => {
  const base = {version: "v1", description: "检查边界", enabled: true, pinned: false,
    shadowed: false, explicit_only: false};
  vi.mocked(listSkills).mockResolvedValue({skills: [
    {...base, ref: "personal:a", name: "个人检查", source: "个人"},
    {...base, ref: "project:b", name: "项目检查", source: "AI-ME"},
  ], diagnostics: []});
  const selected = vi.fn();
  render(<SkillLibrary sessionId="s1" disabled={false} onClose={vi.fn()} onSelect={selected}/>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", {name: "AI-ME"}));
  const sources = within(screen.getByRole("region", {name: "按来源浏览"}));
  expect(sources.queryByText("个人检查")).toBeNull();
  await user.click(sources.getByRole("button", {name: /项目检查/}));
  await user.click(screen.getByRole("button", {name: "在当前会话使用"}));
  expect(selected).toHaveBeenCalledWith("project:b");
  await user.type(screen.getByRole("textbox", {name: "搜索技能"}), "不存在");
  expect(screen.getByText("没有匹配的技能，试试其他关键词。")).toBeTruthy();
});
