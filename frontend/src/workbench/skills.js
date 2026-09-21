import { projectIdFromKey } from "./projects.js";

const skillAddress = (ref) => `aime-skill://${encodeURIComponent(ref)}`;

/** 账本保留精确引用，阅读层显示技能名，避免内部来源 ID 淹没任务标题。 */
export function displaySkillInput(text) {
  return text.replace(/\/skill:([^\s]+)/g, (_match, ref) => {
    try {
      return `$${decodeURIComponent(ref.split(":").at(-1))}`;
    } catch {
      return `$${ref}`;
    }
  });
}

/** 目录返回的是授权引用，不伪造文件路径，也不把正文提前塞入模型上下文。 */
export function createSkillAdapter(api) {
  async function inventory({ sessionId, workspacePath } = {}) {
    if (sessionId) return api.listSkills(sessionId);
    const projectId = projectIdFromKey(workspacePath);
    return projectId ? api.listProjectSkills(projectId) : api.listSkills();
  }
  const summary = (skill) => ({
    id: skill.ref,
    name: skill.name,
    description: skill.description,
    body: "",
    path: skillAddress(skill.ref),
    scope: skill.scope ?? "user",
    enabled: skill.enabled,
    pinned: skill.pinned,
    metadata: { version: skill.version },
  });
  return {
    service: {
      async list(params) {
        const result = await inventory(params);
        return {
          skills: result.skills.map(summary),
          capability: {
            userScopeAvailable: true,
            fileOperationsAvailable: false,
            pluginManagementAvailable: false,
          },
          diagnostics: result.diagnostics.map((message) => ({
            code: "skill_scan_failed",
            severity: "warning",
            message,
          })),
        };
      },
      async setEnabled(params) {
        const result = await inventory(params);
        const skill = result.skills.find(
          (s) =>
            s.ref === params.skillId &&
            (!params.scope || s.scope === params.scope),
        );
        if (!skill) throw new Error("技能已失效，请刷新列表");
        const updated = {
          ...skill,
          enabled: params.enabled ?? skill.enabled,
          pinned: params.pinned ?? skill.pinned,
        };
        const id = projectIdFromKey(params.workspacePath);
        if (id) await api.saveProjectSkillPreference(id, updated);
        else await api.saveSkillPreference(params.sessionId, updated);
      },
    },
    async catalog(params) {
      const result = await inventory(params);
      return {
        authority: params.sessionId ? "session" : "workspace",
        skills: result.skills
          .filter((s) => s.enabled && !s.shadowed)
          .map((s) => {
            const { id, name, description, path, scope } = summary(s);
            return { id, name, description, path, scope, enabled: true };
          }),
      };
    },
    async prepareInput(text, params) {
      // 将原版 Composer 的链接引用转换为 AI-ME 显式调用语法；名称不是权限凭据。
      if (!text.includes("aime-skill://")) return text;
      const result = await inventory(params);
      const allowed = new Set(
        result.skills.filter((s) => s.enabled && !s.shadowed).map((s) => s.ref),
      );
      return text.replace(
        /\[(?:\\.|[^\]])*\]\(<?aime-skill:\/\/([^)>\s]+)>?\)/g,
        (_match, encoded) => {
          const ref = decodeURIComponent(encoded);
          if (!allowed.has(ref))
            throw new Error("引用的技能不属于当前会话或已禁用，请重新选择");
          return `/skill:${ref}`;
        },
      );
    },
  };
}
