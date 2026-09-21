// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createProjectDirectory,
  projectKey,
  sessionWorkspaceKey,
  normalizeWorkspaceKey,
} from "./projects.js";
import { createSkillAdapter } from "./skills.js";
import { createHost, taskMeta } from "./services.js";
import { createProtocol } from "./protocol.js";
import { filterSkillsForProvider } from "../../vendor/zcode/packages/ui/src/lib/skillSourceFilter.ts";
import { buildSkillMentionMarkdown } from "../../vendor/zcode/packages/ui/src/mentions/mentionMarkdown.ts";
import * as api from "../api.ts";

vi.mock("../api.ts", () => ({
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  listModels: vi.fn(),
  listModelConfigurations: vi.fn(),
}));
const projects = [
  {
    id: "p1",
    name: "AI-ME",
    roots: [{ path: "D:/shared", primary: true }, { path: "D:/backend" }],
  },
  {
    id: "p2",
    name: "另一个项目",
    roots: [{ path: "D:/shared", primary: true }],
  },
];
const sessions = [
  {
    id: "s1",
    projectId: "p1",
    workspacePath: "D:/old-root",
    lifecycle: "active",
    activity: "idle",
  },
  {
    id: "s2",
    projectId: "p2",
    workspacePath: "D:/shared",
    lifecycle: "active",
    activity: "idle",
  },
  {
    id: "s3",
    projectId: null,
    workspacePath: "D:/shared",
    lifecycle: "active",
    activity: "idle",
  },
];
beforeEach(() => {
  localStorage.clear();
  api.listProjects.mockResolvedValue(projects);
  api.listSessions.mockResolvedValue(sessions);
  api.listModels.mockResolvedValue([]);
});

describe("项目身份和会话快照", () => {
  it("独立会话规范化 Windows 目录，选目录不能偷绑当前项目", async () => {
    expect(normalizeWorkspaceKey("d:\\Shared\\")).toBe("D:/shared");
    expect(normalizeWorkspaceKey("d:\\")).toBe("D:/");
    expect(normalizeWorkspaceKey("/home/User")).toBe("/home/User");
    const picker = vi.spyOn(window, "prompt").mockReturnValue("D:\\Shared");
    try {
      const { services, directory } = await createHost();
      const result = await services.fileService.ensureConversationWorkspace();
      expect(result).toMatchObject({
        path: "D:/shared",
        workspacePurpose: "conversation",
      });
      expect(directory.sessionInput(result.path)).toEqual({
        workspacePath: "D:/shared",
      });
      expect(
        (
          await services.zcodeTaskService.listTasks({
            workspacePath: "d:\\SHARED",
          })
        ).map((s) => s.taskId),
      ).toEqual(["s3"]);
    } finally {
      picker.mockRestore();
    }
  });
  it("同目录不同项目与独立会话不会合并，多根目录只显示一个项目", () => {
    const directory = createProjectDirectory(projects, sessions);
    expect(directory.paths()).toEqual([
      projectKey("p1"),
      projectKey("p2"),
      "D:/shared",
    ]);
    expect(directory.label(projectKey("p1"))).toBe("AI-ME");
    expect(sessionWorkspaceKey(sessions[0])).toBe(projectKey("p1"));
    expect(directory.sessionInput(projectKey("p1"))).toEqual({
      projectId: "p1",
    });
    expect(directory.sessionInput("D:/shared")).toEqual({
      workspacePath: "D:/shared",
    });
    expect(() => directory.sessionInput(projectKey("deleted"))).toThrow(
      "项目已删除",
    );
  });
  it("实际列表接口按归属筛选，旧快照不因主目录改变而丢失", async () => {
    const { services } = await createHost();
    expect(
      (
        await services.zcodeTaskService.listTasks({
          workspacePath: projectKey("p1"),
        })
      ).map((s) => s.taskId),
    ).toEqual(["s1"]);
    const result = await services.zcodeTaskService.listTaskList({
      workspaceScopes: [{ workspacePath: "D:/shared" }],
      kind: "all",
    });
    expect(result.items.map((s) => s.taskId)).toEqual(["s3"]);
  });
  it("V4 首发向真实 API 提交 projectId 而不是逻辑地址", async () => {
    const backend = {
      createSession: vi.fn().mockResolvedValue(sessions[0]),
      startTurn: vi.fn().mockResolvedValue({ id: "t1" }),
    };
    const directory = createProjectDirectory(projects, sessions);
    const protocol = createProtocol(
      backend,
      [{ ref: "custom/test" }],
      taskMeta,
      directory,
    );
    await protocol.agent.sendConversationCommandV4({
      workspacePath: projectKey("p1"),
      envelope: {
        clientId: "c1",
        commandId: "cmd1",
        type: "createSession",
        payload: { firstInput: { text: "hello" } },
      },
    });
    expect(backend.createSession).toHaveBeenCalledWith({
      projectId: "p1",
      defaultModel: "custom/test",
      permissionProfile: "workspace_write",
    });
  });
});

describe("原版 Skill 组件到 AI-ME Runtime", () => {
  const entry = {
    ref: "project:root/review",
    name: "review",
    scope: "workspace",
    description: "代码审阅",
    enabled: true,
    pinned: true,
    version: "v1",
  };
  function fixture() {
    const backend = {
      listSkills: vi
        .fn()
        .mockResolvedValue({ skills: [entry], diagnostics: [] }),
      listProjectSkills: vi
        .fn()
        .mockResolvedValue({ skills: [entry], diagnostics: [] }),
      saveProjectSkillPreference: vi.fn(),
      saveSkillPreference: vi.fn(),
    };
    return { backend, adapter: createSkillAdapter(backend) };
  }
  it("项目草稿和会话的目录权限来源不同", async () => {
    const { backend, adapter } = fixture();
    await adapter.catalog({ workspacePath: projectKey("p1") });
    expect(backend.listProjectSkills).toHaveBeenCalledWith("p1");
    await adapter.catalog({ workspacePath: projectKey("p1"), sessionId: "s1" });
    expect(backend.listSkills).toHaveBeenCalledWith("s1");
  });
  it("原版过滤器保留授权技能，原版 Markdown 引用变成显式运行指令", async () => {
    const { adapter } = fixture();
    const { skills } = await adapter.catalog({ sessionId: "s1" });
    expect(filterSkillsForProvider(skills, "glm")).toHaveLength(1);
    const text =
      buildSkillMentionMarkdown(skills[0].name, skills[0].path) + " 帮我审查";
    expect(await adapter.prepareInput(text, { sessionId: "s1" })).toBe(
      "/skill:project:root/review 帮我审查",
    );
    await expect(
      adapter.prepareInput(
        buildSkillMentionMarkdown("fake", "aime-skill://private"),
        { sessionId: "s1" },
      ),
    ).rejects.toThrow("不属于当前会话");
  });
  it("启停保留 pinned 偏好，并重新校验技能归属", async () => {
    const { backend, adapter } = fixture();
    await adapter.service.setEnabled({
      workspacePath: projectKey("p1"),
      skillId: entry.ref,
      scope: "workspace",
      enabled: false,
    });
    expect(backend.saveProjectSkillPreference).toHaveBeenCalledWith("p1", {
      ...entry,
      enabled: false,
    });
    await expect(
      adapter.service.setEnabled({ skillId: "missing", enabled: true }),
    ).rejects.toThrow("技能已失效");
  });
});
