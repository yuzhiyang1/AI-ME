// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SkillPicker } from "./SkillPicker";
import { listSkills, saveSkillPreference } from "./api";

vi.mock("./api", () => ({listSkills: vi.fn(), saveSkillPreference: vi.fn()}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const skill = {ref: "root:review", name: "代码检查", description: "检查边界和测试", version: "v1",
  enabled: true, pinned: false, shadowed: false, explicit_only: false};

it("未创建会话也能从常驻入口查看个人列表，但不能直接使用", async () => {
  vi.mocked(listSkills).mockResolvedValue({skills: [skill], diagnostics: []});
  render(<SkillPicker library disabled={true} onSelect={vi.fn()}/>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", {name: "Skill 列表"}));
  expect(await screen.findByText("代码检查")).toBeTruthy();
  expect(listSkills).toHaveBeenCalledWith(undefined);
  expect((screen.getByRole("button", {name: "请先进入会话"}) as HTMLButtonElement).disabled).toBe(true);
});

it("大列表可以翻页，搜索后回到第一页", async () => {
  const skills = Array.from({length: 21}, (_, index) => ({...skill, ref: `r:${index}`, name: `手册-${index}`}));
  vi.mocked(listSkills).mockResolvedValue({skills, diagnostics: []});
  render(<SkillPicker library sessionId="s1" disabled={false} onSelect={vi.fn()}/>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", {name: "Skill 列表"}));
  await user.click(await screen.findByRole("button", {name: "下一页"}));
  expect(screen.getByText("手册-20")).toBeTruthy();
  await user.type(screen.getByRole("textbox"), "手册-0");
  expect(await screen.findByText("手册-0")).toBeTruthy();
});

it("按准确引用选中 Skill，不把正文塞入输入框", async () => {
  vi.mocked(listSkills).mockResolvedValue({skills: [skill], diagnostics: []});
  const selected = vi.fn();
  render(<SkillPicker sessionId="s1" disabled={false} onSelect={selected}/>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", {name: "Skill"}));
  await user.click(await screen.findByRole("button", {name: "使用"}));
  expect(selected).toHaveBeenCalledWith("root:review");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("停用后不能选择，偏好按服务端成功结果更新", async () => {
  vi.mocked(listSkills).mockResolvedValue({skills: [skill], diagnostics: ["缺少描述"]});
  vi.mocked(saveSkillPreference).mockResolvedValue({saved: true});
  render(<SkillPicker sessionId="s1" disabled={false} onSelect={vi.fn()}/>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", {name: "Skill"}));
  await user.click(await screen.findByRole("checkbox", {name: "启用"}));
  await waitFor(() => expect(saveSkillPreference).toHaveBeenCalledWith("s1", {...skill, enabled: false}));
  await waitFor(() => expect((screen.getByRole("button", {name: "使用"}) as HTMLButtonElement).disabled).toBe(true));
});
