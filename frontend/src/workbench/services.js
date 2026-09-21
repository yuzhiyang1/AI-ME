import * as api from "../api.ts";
import { createEvent, serviceBoundary } from "./events.js";
import { createProtocol, parseTimestamp } from "./protocol.js";
import { desktopPlatform } from "./desktop-platform.js";

const SETTINGS_KEY = "ai-me:zcode:settings:v1";

/** 只投影后端公开的模型元数据，不把密钥交给 ZCode 或写入浏览器。 */
export function modelView(models) {
  const providers = new Map();
  for (const model of models) {
    if (!providers.has(model.provider))
      providers.set(model.provider, {
        providerId: model.provider,
        providerName: model.provider,
        config: {
          group: "AI-ME",
          access: { type: "api-key" },
          api: { type: "openai-completions", baseUrl: "" },
        },
        models: [],
      });
    providers.get(model.provider).models.push({
      modelId: model.modelId,
      config: {
        enabled: true,
        properties: {
          contextWindow: model.contextWindow,
          requiresMfjsToolSchema: false,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        },
        // AI-ME 当前不暴露推理强度覆盖；唯一档位表示沿用后端模型默认值。
        optionSpecs: {
          reasoningLevel: { values: ["default"], map: "{}" },
          maxOutputTokens: { max: model.contextWindow, map: "{}" },
        },
      },
    });
  }
  const first = models[0];
  const effectiveSelection = first
    ? {
        providerId: first.provider,
        modelId: first.modelId,
        options: { reasoningLevel: "default" },
      }
    : null;
  return {
    revision: 1,
    providers: [...providers.values()],
    preferredSelection: effectiveSelection,
    effectiveSelection,
    ...(first ? {} : { selectionIssue: "selection-missing" }),
  };
}

export function taskMeta(session) {
  return {
    taskId: session.id,
    traceId: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    createdAt: parseTimestamp(session.createdAt),
    updatedAt: parseTimestamp(session.updatedAt),
    mode: "build",
    model: session.defaultModel,
    status: session.activity === "running" ? "running" : "completed",
    sourceAvailability: "online",
    liveStatus: session.activity === "idle" ? "completed" : "running",
  };
}

export async function createHost() {
  const [models, sessions, projects] = await Promise.all([
    api.listModels(),
    api.listSessions(),
    api.listProjects(),
  ]);
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    /* 损坏偏好不阻止启动。 */
  }
  const paths = [
    ...new Set([
      ...projects.flatMap((project) => project.roots.map((root) => root.path)),
      ...sessions.map((session) => session.workspacePath),
    ]),
  ];
  const workspacePath = saved.recentProjects?.[0] || paths[0];
  let settings = {
    locale: "zh-CN",
    localePreference: "zh-CN",
    recentProjects: paths,
    onboardingOccupation: "developer",
    providerFamilyDomainMigrated: true,
    settingsSyncFirstRunPromptHandled: true,
    ...saved,
  };
  const broadcast = createEvent();
  let view = modelView(models);
  const modelChanges = createEvent();
  const providerChanges = createEvent();
  const protocol = createProtocol(api, models, taskMeta);
  const buildProviderView = () => ({
    revision: view.revision,
    providerTemplates: [],
    providerOrder: view.providers.map((p) => p.providerId),
    providers: view.providers.map((p) => ({
      ...p,
      enabled: true,
      executable: true,
      effectiveConfig: p.config,
      issues: [],
      models: p.models.map((m) => ({
        modelId: m.modelId,
        enabled: true,
        executable: true,
        effectiveConfig: m.config,
        issues: [],
      })),
    })),
  });
  let providerView = buildProviderView();
  let refreshInFlight;
  // 模型数组保持引用稳定：V4 协议创建新会话时也必须读到刚保存的模型。
  const refreshModels = () => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = api
      .listModels()
      .then(async (latest) => {
        models.splice(0, models.length, ...latest);
        view = { ...modelView(models), revision: view.revision + 1 };
        providerView = buildProviderView();
        modelChanges.emit(view);
        providerChanges.emit(providerView);
        await protocol.refreshModels();
        return providerView;
      })
      .finally(() => {
        refreshInFlight = undefined;
      });
    return refreshInFlight;
  };
  const taskList = async (query) => {
    const all = await api.listSessions();
    const items = all
      .filter((s) =>
        query.workspaceScopes.some((w) => w.workspacePath === s.workspacePath),
      )
      .filter((s) =>
        query.kind === "archived"
          ? s.lifecycle === "archived"
          : s.lifecycle !== "archived",
      )
      .filter((s) => query.kind !== "pinned" || s.pinned)
      .filter((s) => query.kind !== "active" || s.activity !== "idle")
      .filter(
        (s) =>
          !query.search ||
          s.title.toLowerCase().includes(query.search.toLowerCase()),
      )
      .sort(
        (a, b) =>
          parseTimestamp(
            b[query.sortBy === "created" ? "createdAt" : "updatedAt"],
          ) -
          parseTimestamp(
            a[query.sortBy === "created" ? "createdAt" : "updatedAt"],
          ),
      )
      .map(taskMeta);
    return {
      items: query.limit ? items.slice(0, query.limit) : items,
      total: items.length,
      hasMore: Boolean(query.limit && items.length > query.limit),
    };
  };
  const implementations = {
    settingService: {
      get: async () => settings,
      update: async (patch) => {
        settings = { ...settings, ...patch };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      },
    },
    broadcastService: {
      onMessage: broadcast.listen,
      send: async (message) => broadcast.emit(message),
    },
    // AI-ME 凭证只由后端管理；本宿主不存在 ZCode OAuth 凭证。
    credentialService: { load: async () => null },
    onboardingRecordService: {
      shouldOnboard: async () => !settings.onboardingOccupation,
      claimAnonymousRecord: async () => {},
      getLatestEntry: async () => null,
      syncSettingsFromRecord: async () => null,
    },
    settingsSyncService: {
      getFirstRunPromptState: async () => ({ handled: true }),
    },
    oauthService: {
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
      getActiveProvider: async () => null,
      restoreSession: async () => null,
    },
    modelSelectionService: {
      onDidChange: modelChanges.listen,
      getView: async (input) => {
        const selected = input?.selection;
        if (!selected) return view;
        const exists = models.some(
          (m) =>
            m.provider === selected.providerId &&
            m.modelId === selected.modelId,
        );
        return exists
          ? {
              ...view,
              effectiveSelection: {
                ...selected,
                options: { reasoningLevel: "default" },
              },
            }
          : {
              ...view,
              effectiveSelection: null,
              selectionIssue: "model-not-found",
            };
      },
    },
    clientScenesService: {
      list: async () => ({ code: 0, msg: "AI-ME 未配置推荐场景", data: [] }),
    },
    subagentsService: {
      list: async () => ({
        agents: [],
        userAgents: [],
        pluginAgents: [],
        capability: {
          userScopeAvailable: false,
          userScopeReason: "desktop_only",
        },
      }),
    },
    providerSettingsService: {
      getView: async () => providerView,
      onDidChange: providerChanges.listen,
      refresh: refreshModels,
      listLocalConfigurations: api.listModelConfigurations,
      createLocalConfiguration: async (input) => {
        const configuration = await api.createModelConfiguration(input);
        // 写入成功与刷新失败分开报告，避免用户重试导致重复新增。
        try {
          // 启动时可能仍在读取旧目录；等待旧请求结束，再读取提交后的权威目录。
          if (refreshInFlight) await refreshInFlight.catch(() => {});
          await refreshModels();
          return { configuration };
        } catch (error) {
          return { configuration, refreshError: error.message };
        }
      },
    },
    codingPlanSubscriptionService: {
      getDynamicWorkflowClientConfig: async () => ({
        mode: "disabled",
        enabled: false,
        source: "ai-me",
      }),
    },
    zcodeTaskService: {
      getTaskMeta: async ({ taskId }) => taskMeta(await api.getSession(taskId)),
      onDynamicWorkspaceEvent: protocol.taskEvents,
      getTaskNativeSessionLogFile: async () => ({
        provider: null,
        path: null,
        exists: false,
      }),
      getTaskSessionFilePath: async () => ({ path: "", exists: false }),
      listTaskList: taskList,
      listTasks: async ({ workspacePath: path }) =>
        (await api.listSessions())
          .filter(
            (s) =>
              s.workspacePath === path &&
              s.lifecycle !== "archived" &&
              !s.pinned,
          )
          .map(taskMeta),
      listPinnedTasks: async ({ workspacePath: path }) =>
        (await api.listSessions())
          .filter(
            (s) =>
              s.workspacePath === path &&
              s.pinned &&
              s.lifecycle !== "archived",
          )
          .map(taskMeta),
      listArchivedTasks: async ({ workspacePath: path }) =>
        (await api.listSessions())
          .filter((s) => s.workspacePath === path && s.lifecycle === "archived")
          .map(taskMeta),
      listPinnedTaskIds: async () =>
        (await api.listSessions()).filter((s) => s.pinned).map((s) => s.id),
      listDeletedTaskIds: async () => [],
      listGroupedTaskViewStructure: async () => ({
        groups: [],
        members: [],
        topLevelOrders: [],
      }),
      getGroupedTaskView: async () => ({ nodes: [] }),
    },
    windowControllerService: { ...protocol.controller, listTaskList: taskList },
    zcodeAgentService: protocol.agent,
    zcodeSessionService: {
      initializeWorkspace: async ({ workspacePath: path }) => ({
        available: models.length > 0,
        workspaceKey: path,
        reason: models.length ? undefined : "请先配置 AI-ME 模型",
      }),
      getWorkspaceRuntimeIdentity: async ({ workspacePath: path }) => ({
        generation: 1,
        identity: path,
        workspaceKey: path,
      }),
      readWorkspacePresentation: async ({ workspacePath: path }) => ({
        workspace: { path },
        mode: "build",
        slashCommands: [],
      }),
    },
    fileService: {
      resolvePath: async ({ path }) => path,
      ensureConversationWorkspace: async () => {
        if (!workspacePath) throw new Error("请先选择 AI-ME 工作区");
        return {
          path: workspacePath,
          created: false,
          workspacePurpose: "project",
        };
      },
    },
  };
  const names = [
    "file",
    "git",
    "gitCheckpoint",
    "system",
    "terminal",
    "setting",
    "credential",
    "broadcast",
    "zcodeTask",
    "zcodeAgent",
    "zcodeSession",
    "windowController",
    "conversationShare",
    "fileWatcher",
    "oauth",
    "providerSettings",
    "modelSelection",
    "usageStats",
    "codingPlanSubscription",
    "clientConfig",
    "clientScenes",
    "offPeakTask",
    "skills",
    "skillSync",
    "mcpSync",
    "pluginSync",
    "plugins",
    "pluginManagement",
    "subagents",
    "commands",
    "hooks",
    "memory",
    "settingsSync",
    "feedback",
    "promptAttachmentTransfer",
  ];
  const services = Object.fromEntries(
    names.map((name) => {
      const key = `${name}Service`;
      return [key, serviceBoundary(key, implementations[key])];
    }),
  );
  services.onboardingRecordService = serviceBoundary(
    "onboardingRecordService",
    implementations.onboardingRecordService,
  );
  const platform = new Proxy(
    {
      supportsDraftSessionPrewarm: false,
      canSelectFilePath: false,
      getWindowControlsOverlayMetrics: () => undefined,
      // 浏览器通知只有用户已授予权限时才发送，不主动申请权限。
      showTaskNotification: (payload) => {
        if (
          !document.hasFocus() &&
          "Notification" in window &&
          Notification.permission === "granted"
        )
          new Notification(payload.title, { body: payload.body, silent: true });
      },
      selectDirectory: async () =>
        window.aiMeDesktop?.selectWorkspace
          ? window.aiMeDesktop.selectWorkspace()
          : window.prompt("输入本机已有工作区绝对路径", workspacePath || ""),
      selectFile: async () => null,
      selectFiles: async () => [],
      getPathForFile: () => null,
      activateOrSetWorkspace: async () => ({ activated: false }),
      getDeviceId: () => "ai-me-local",
      openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      canOpenCommunity: async () => false,
      getUpdateState: async () => ({ kind: "idle", enabled: false }),
      getInstalledEditors: async () => [],
      getDesktopZoomLevel: async () => ({ zoomLevel: 0 }),
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
      ...desktopPlatform(window.aiMeDesktop),
    },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== "string" || key === "then") return undefined;
        // Web 宿主没有窗口生命周期；遥测明确不发送到上游。
        if (key.startsWith("on")) return () => () => {};
        if (
          key.startsWith("sync") ||
          key.startsWith("report") ||
          [
            "notifyRendererReady",
            "setApplicationLocale",
            "setTitleBarTheme",
          ].includes(key)
        )
          return async () => {};
        return async () => {
          throw new Error(`AI-ME 尚未接入宿主能力：${key}`);
        };
      },
    },
  );
  return { services, platform, workspacePath };
}
