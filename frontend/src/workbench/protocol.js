import { conversationSnapshotSchema } from "../../vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts";
import { createEvent } from "./events.js";
import { projectToolPresentation } from "./tool-presentation.js";
import { sessionWorkspaceKey, normalizeWorkspaceKey } from "./projects.js";
import { displaySkillInput } from "./skills.js";

const unavailable = { allowed: false, reasonCode: "AI-ME 尚未接入此能力" };
/** SQLite 返回的无偏移时间是 UTC，不能交给浏览器按本地时区解释。 */
export function parseTimestamp(value) {
  if (typeof value !== "string") return Number(value) || 0;
  return Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
}
export const sessionPhase = (session) =>
  session.activity === "idle" ? "completedSuccess" : "running";

/** 从 AI-ME 权威记录生成 ZCode 行；rowId 由实体 ID 分配，流式更新时保持稳定。 */
export function projectConversation({
  session,
  items,
  tools,
  approvals,
  usage,
  activeTurn,
  rowIds,
  commandByTurn,
  epoch,
  seq,
}) {
  const idFor = (key) => {
    if (!rowIds.has(key)) rowIds.set(key, rowIds.size + 1);
    return rowIds.get(key);
  };
  const entries = [
    ...items.map((item) => ({
      key: item.id,
      time: item.createdAt,
      turnId: item.turnId,
      item,
    })),
    ...tools.map((tool) => ({
      key: tool.id,
      time: tool.preparedAt,
      turnId: tool.turnId,
      tool,
    })),
  ].sort((a, b) => parseTimestamp(a.time) - parseTimestamp(b.time));
  const rows = [];
  const turns = new Set();
  const failedTurns = new Set(
    items
      .filter((item) => item.type === "error" || item.status === "failed")
      .map((item) => item.turnId),
  );
  for (const entry of entries) {
    if (!turns.has(entry.turnId)) {
      turns.add(entry.turnId);
      rows.push({
        rowId: idFor(`turn:${entry.turnId}`),
        entityId: entry.turnId,
        turnId: entry.turnId,
        createdAt: parseTimestamp(entry.time),
        createdAtSeq: 1,
        kind: "turnHeader",
        origin: "userInput",
        state:
          activeTurn?.id === entry.turnId
            ? "running"
            : failedTurns.has(entry.turnId)
              ? "failed"
              : "completedSuccess",
        startedAt: parseTimestamp(entry.time),
      });
    }
    const base = {
      rowId: idFor(entry.key),
      entityId: entry.key,
      turnId: entry.turnId,
      createdAt: parseTimestamp(entry.time),
      createdAtSeq: 1,
    };
    if (entry.item) {
      const item = entry.item;
      rows.push(
        item.type === "user_message"
          ? {
              ...base,
              kind: "userInput",
              text: displaySkillInput(String(item.content.text || "")),
              origin: "realUser",
              sourceCommandId: commandByTurn.get(item.turnId),
            }
          : {
              ...base,
              kind: "assistantText",
              text: String(item.content.text || item.content.message || ""),
              state:
                item.status === "in_progress"
                  ? "streaming"
                  : item.status === "failed"
                    ? "failed"
                    : "complete",
            },
      );
    } else {
      const tool = entry.tool;
      const status = {
        prepared: "running",
        waiting_for_approval: "pendingApproval",
        running: "running",
        completed: "success",
        failed: "error",
        rejected: "cancelled",
        uncertain: "error",
      }[tool.status];
      rows.push({
        ...base,
        kind: "toolCall",
        toolCallId: tool.callId,
        toolName: tool.toolName,
        status,
        inputText: JSON.stringify(tool.arguments),
        input: tool.arguments,
        ...(tool.result
          ? {
              output: {
                text:
                  typeof tool.result.output === "string"
                    ? tool.result.output
                    : JSON.stringify(tool.result),
              },
            }
          : {}),
        ...(status === "error"
          ? {
              error: {
                code: "ai-me.tool",
                message: JSON.stringify(tool.result),
              },
            }
          : {}),
        ...projectToolPresentation(tool),
        ...(approvals.find((a) => a.invocationId === tool.id)
          ? {
              approvalInteractionId: approvals.find(
                (a) => a.invocationId === tool.id,
              ).id,
            }
          : {}),
      });
    }
  }
  const busy = session.activity !== "idle";
  const lastEntry = entries.at(-1);
  const lastErrorItem = items
    .filter(
      (item) => item.turnId === lastEntry?.turnId && item.type === "error",
    )
    .at(-1);
  const phase =
    !busy && lastErrorItem
      ? "error"
      : rows.length
        ? sessionPhase(session)
        : "draft";
  const [provider, ...modelParts] = session.defaultModel.split("/");
  const model = modelParts.join("/");
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: session.id,
    logEpoch: epoch,
    seq,
    revision: seq,
    control: {
      phase,
      sessionEnded: !busy && rows.length > 0,
      canStop: Boolean(activeTurn),
      stopState: activeTurn ? "stoppable" : "idle",
      stopTargetKind: "unknown",
      activeWorks: activeTurn
        ? [
            {
              kind: "primaryTurn",
              foregroundExecutionId: activeTurn.id,
              startedAt: parseTimestamp(
                activeTurn.createdAt || session.updatedAt,
              ),
            },
          ]
        : [],
      lastError: lastErrorItem
        ? {
            code: "ai-me.turn-failed",
            message: String(
              lastErrorItem.content.message ||
                lastErrorItem.content.text ||
                "执行失败",
            ),
            recoverable: true,
            at: parseTimestamp(lastErrorItem.createdAt),
            source: "runtime",
          }
        : null,
      apiRetry: null,
    },
    availability: Object.fromEntries(
      [
        "fork",
        "compact",
        "switchModelConfig",
        "setFollowupMode",
        "queueEdit",
        "sendQueuedNow",
        "pauseGoal",
        "resumeGoal",
      ].map((key) => [key, unavailable]),
    ),
    inputRouting: busy
      ? { mode: "reject", reasonCode: "当前任务执行中，请等待完成或停止" }
      : { mode: "startNow" },
    meta: { title: session.title, titleSource: "generated" },
    config: {
      modelSelection: {
        providerId: provider,
        modelId: model,
        options: { reasoningLevel: "default" },
      },
      provider,
      model,
      thought: "default",
      thoughtLevels: ["default"],
      followupMode: "queue",
      mode: "build",
    },
    usage: {
      contextWindow:
        usage.contextWindow && usage.currentContextTokens != null
          ? {
              usedTokens: usage.currentContextTokens,
              maxTokens: usage.contextWindow,
              autoCompactThresholdTokens: null,
              estimated: Boolean(usage.contextEstimated),
              windowNumber: usage.windowNumber ?? null,
            }
          : null,
      cumulative: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    workflowRuns: { revision: 0, runs: [] },
    pendingInteractions: approvals.map((approval) => ({
      interactionId: approval.id,
      kind: "permission",
      anchorRowId: rowIds.get(approval.invocationId) || null,
      createdAt: parseTimestamp(approval.requestedAt),
      payload: {
        kind: "permission",
        toolCallId:
          tools.find((t) => t.id === approval.invocationId)?.callId ||
          approval.invocationId,
        toolName: approval.toolName,
        summary: approval.reason,
        detail: approval.arguments,
        options: [
          { optionId: "approve_once", label: "允许一次", kind: "allowOnce" },
          {
            optionId: "approve_session",
            label: "本会话允许",
            kind: "allowAlways",
          },
          { optionId: "reject", label: "拒绝", kind: "deny" },
        ],
      },
    })),
    rows: {
      window: rows.sort((a, b) => a.rowId - b.rowId),
      totalCount: rows.length,
      firstRowId: rows.length ? 1 : null,
    },
  });
}

/** 单个浏览器附件的订阅桥。定时重读权威记录，变化才发帧；最后一次退订后停止 IO。 */
export function createProtocol(api, models, taskMeta, workspace = {}) {
  const epoch = crypto.randomUUID();
  const subscriptions = new Map();
  const events = {
    conversation: createEvent(),
    "sessions-index": createEvent(),
    "workspace-config": createEvent(),
    controller: createEvent(),
  };
  const workspaceEvents = createEvent();
  const commandCache = new Map();
  const commandByTurn = new Map();
  const rowIdsBySession = new Map();
  let timer;
  const modelConfig = () => ({
    configOptions: [
      {
        id: "model",
        name: "模型",
        type: "select",
        currentValue: models[0]?.ref || "",
        options: models.map((m) => ({
          value: m.ref,
          name: m.displayName,
          modelProviderId: m.provider,
          modelProviderName: m.provider,
          modelThoughtLevels: [],
        })),
      },
    ],
    slashCommands: [],
  });
  let config = modelConfig();
  async function snapshot(sub) {
    if (sub.kind === "conversation") {
      const id = sub.params.sessionId;
      const [session, items, tools, approvals, usage, activeTurn] =
        await Promise.all([
          api.getSession(id),
          api.listSessionItems(id),
          api.listToolInvocations(id),
          api.listPendingApprovals(id),
          api.getSessionUsage(id),
          api.getActiveTurn(id),
        ]);
      if (!rowIdsBySession.has(id)) rowIdsBySession.set(id, new Map());
      return projectConversation({
        session,
        items,
        tools,
        approvals,
        usage,
        activeTurn,
        rowIds: rowIdsBySession.get(id),
        commandByTurn,
        epoch,
        seq: 0,
      });
    }
    if (sub.kind === "workspace-config")
      return {
        protocolVersion: 1,
        workspaceId: sub.params.workspacePath,
        logEpoch: epoch,
        config,
      };
    const sessions = await api.listSessions();
    if (sub.kind === "controller") {
      if (sub.topic.endsWith("workspaces"))
        return {
          protocolVersion: 1,
          logEpoch: epoch,
          workspaces: [...new Set(sessions.map(sessionWorkspaceKey))].map(
            (path) => ({
              workspacePath: path,
              sourceAvailability: "online",
              connectionState: "online",
            }),
          ),
        };
      return {
        protocolVersion: 1,
        logEpoch: epoch,
        tasks: sessions.map((s) => ({
          address: { workspacePath: sessionWorkspaceKey(s), taskId: s.id },
          meta: taskMeta(s),
          membership: {
            pinned: s.pinned,
            archived: s.lifecycle === "archived",
            active: s.activity !== "idle",
          },
          sourceAvailability: "online",
          liveStatus: s.activity === "idle" ? "completed" : "running",
        })),
      };
    }
    return {
      protocolVersion: 1,
      workspaceId: sub.params.workspacePath,
      logEpoch: epoch,
      sessions: sessions
        .filter(
          (s) =>
            sessionWorkspaceKey(s) === normalizeWorkspaceKey(sub.params.workspacePath) &&
            s.lifecycle !== "archived",
        )
        .map((s) => ({
          sessionId: s.id,
          workspaceId: sessionWorkspaceKey(s),
          title: displaySkillInput(s.title),
          phase: sessionPhase(s),
          sessionEnded: s.activity === "idle",
          hasBackgroundWork: false,
          lastActivityAt: parseTimestamp(s.updatedAt),
          createdAt: parseTimestamp(s.createdAt),
        })),
    };
  }
  async function publish(sub, force = false) {
    if (sub.loading || !subscriptions.has(sub.id)) return;
    sub.loading = true;
    try {
      const value = await snapshot(sub);
      const signature = JSON.stringify(value);
      if (!subscriptions.has(sub.id) || (!force && signature === sub.signature))
        return;
      sub.signature = signature;
      sub.seq++;
      if (sub.kind === "sessions-index")
        workspaceEvents.emit({
          type: "workspace_task_list_changed",
          workspacePath: sub.params.workspacePath,
          reason: "task_meta_changed",
          timestamp: Date.now(),
        });
      if (sub.kind === "conversation") {
        value.seq = sub.seq;
        value.revision = sub.seq;
      }
      const frame = {
        topic: sub.topic,
        subscriptionId: sub.id,
        fromSeq: 0,
        toSeq: sub.seq,
        sentAt: Date.now(),
        payload: { kind: "snapshot", snapshot: value },
      };
      if (sub.kind === "controller")
        events.controller.emit({ ...frame, logEpoch: epoch });
      else
        events[sub.kind].emit({
          wireVersion: 3,
          kind: "complete",
          deliveryKind: sub.seq === 1 ? "initial" : "online",
          logicalFrameId: crypto.randomUUID(),
          logicalFrameOrdinal: sub.seq,
          topic: sub.topic,
          subscriptionId: sub.id,
          frame,
        });
    } catch (error) {
      console.error("[AI-ME projection]", sub.kind, error);
    } finally {
      sub.loading = false;
    }
  }
  function subscribe(kind, params) {
    const id = crypto.randomUUID();
    const topic =
      kind === "controller"
        ? params.topic
        : `${kind}/${kind === "conversation" ? params.sessionId : params.workspacePath}`;
    const sub = { id, kind, params, topic, seq: 0 };
    subscriptions.set(id, sub);
    // ACK 必须先交给上游注册 ownership，再投递 initial 帧。
    setTimeout(() => publish(sub), 0);
    timer ??= setInterval(() => {
      for (const entry of subscriptions.values())
        if (entry.kind !== "workspace-config") void publish(entry);
    }, 1000);
    return Promise.resolve({
      ack: { subscriptionId: id, mode: "snapshot", logEpoch: epoch },
    });
  }
  async function unsubscribe({ subscriptionId }) {
    subscriptions.delete(subscriptionId);
    if (!subscriptions.size) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  async function resync({ subscriptionId }) {
    const sub = subscriptions.get(subscriptionId);
    if (sub) await publish(sub, true);
    return { mode: "snapshot" };
  }
  async function execute({ workspacePath, envelope }) {
    const { commandId, type, payload, sessionId } = envelope;
    const accepted = (result) => ({
      commandId,
      status: "accepted",
      revisionAtDecision: 0,
      ...(result ? { result } : {}),
    });
    const input = type === "createSession" ? payload.firstInput : payload;
    if (input?.mode && input.mode !== "build")
      return {
        commandId,
        status: "rejected",
        reasonCode: "ai-me.unsupported-mode",
        message: "当前接入仅支持变更前确认模式，不能静默改变执行权限",
        revisionAtDecision: 0,
      };
    if (
      input?.attachments?.length ||
      input?.planEnabled ||
      input?.context_refs?.length
    )
      return {
        commandId,
        status: "rejected",
        reasonCode: "ai-me.unsupported-input",
        message: "附件、计划或分享上下文尚未接入 AI-ME",
        revisionAtDecision: 0,
      };
    if (type === "createSession") {
      // AI-ME 没有内存草稿会话，明确拒绝预热；原版会自动走首发创建路径。
      // 不能把页面加载产生的预热请求持久化成用户任务。
      if (!payload.firstInput)
        return {
          commandId,
          status: "rejected",
          reasonCode: "ai-me.draft-prewarm-unavailable",
          message: "AI-ME 在首次发送时创建会话",
          revisionAtDecision: 0,
        };
      const selection = input?.modelSelection || payload.config?.modelSelection;
      const modelRef = selection
        ? `${selection.providerId}/${selection.modelId}`
        : models[0]?.ref;
      if (!modelRef) throw new Error("请先配置 AI-ME 模型");
      const session = await api.createSession({
        ...(workspace.sessionInput?.(workspacePath) ?? { workspacePath }),
        defaultModel: modelRef,
        permissionProfile: "workspace_write",
      });
      workspaceEvents.emit({
        type: "workspace_task_list_changed",
        workspacePath,
        taskId: session.id,
        taskMeta: taskMeta(session),
        reason: "task_created",
      });
      if (input?.text) {
        const text = workspace.prepareInput
          ? await workspace.prepareInput(input.text, {
              sessionId: session.id,
              workspacePath,
            })
          : input.text;
        const turn = await api.startTurn(session.id, text, commandId);
        commandByTurn.set(turn.id, commandId);
        return accepted({
          type,
          sessionId: session.id,
          input: { delivery: "startNow", inputId: turn.id },
        });
      }
      return accepted({ type, sessionId: session.id });
    }
    if (type === "sendText") {
      const session = await api.getSession(sessionId);
      if (
        payload.modelSelection &&
        `${payload.modelSelection.providerId}/${payload.modelSelection.modelId}` !==
          session.defaultModel
      )
        throw new Error("现有会话暂不支持切换模型，请新建任务选择模型");
      const text = workspace.prepareInput
        ? await workspace.prepareInput(payload.text, {
            sessionId,
            workspacePath,
          })
        : payload.text;
      const turn = await api.startTurn(sessionId, text, commandId);
      commandByTurn.set(turn.id, commandId);
      return accepted({
        type: "inputAccepted",
        delivery: "startNow",
        inputId: turn.id,
      });
    }
    if (type === "stop") {
      const turn = await api.getActiveTurn(sessionId);
      if (
        turn &&
        (!payload.expectedForegroundExecutionId ||
          payload.expectedForegroundExecutionId === turn.id)
      )
        await api.interruptTurn(sessionId, turn.id);
      return accepted();
    }
    if (type === "resolveInteraction") {
      const optionId = payload.answer?.optionId;
      if (!["approve_once", "approve_session", "reject"].includes(optionId))
        throw new Error("未知审批选项");
      await api.decideApproval(sessionId, payload.interactionId, optionId);
      return accepted({
        type,
        resolvedBy: { clientId: envelope.clientId, optionId },
      });
    }
    return {
      commandId,
      status: "rejected",
      reasonCode: "ai-me.unsupported",
      message: `AI-ME 尚未接入命令：${type}`,
      revisionAtDecision: 0,
    };
  }
  const agent = {
    helloConversationV4: async () => ({
      kind: "hello",
      protocolVersion: 3,
      connectionId: epoch,
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: Date.now(),
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    }),
    initializeConversationV4: async () => {},
    getStorageStartupState: async () => null,
    conversationPlansV4: async ({ sessionId }) => ({
      plans: [],
      atSeq:
        [...subscriptions.values()].find(
          (s) => s.params.sessionId === sessionId,
        )?.seq || 0,
      atLogEpoch: epoch,
    }),
    conversationWorkflowRunsV4: async () => ({ runs: [] }),
    prepareStorage: async () => {
      await api.listSessions();
    },
    getWorkspaceRuntimeIdentity: async ({ workspacePath }) => ({
      generation: 1,
      identity: epoch,
      workspaceKey: workspacePath,
    }),
    sendConversationCommandV4: async (params) => {
      // 同一 commandId 的并发重试共享 Promise，不能创建两次任务。
      const key = `${params.envelope.clientId}:${params.envelope.commandId}`;
      if (!commandCache.has(key)) commandCache.set(key, execute(params));
      return commandCache.get(key);
    },
    queryConversationCommandsV4: async ({ commands }) => ({
      results: await Promise.all(
        commands.map(async (key) => {
          const entry = [...commandCache.entries()].find(([id]) =>
            id.endsWith(`:${key.commandId}`),
          );
          return { key, result: entry ? await entry[1] : "unknown" };
        }),
      ),
    }),
  };
  for (const [suffix, kind] of [
    ["Conversation", "conversation"],
    ["SessionsIndex", "sessions-index"],
    ["WorkspaceConfig", "workspace-config"],
  ]) {
    agent[`subscribe${suffix}V4`] = (params) => subscribe(kind, params);
    agent[`unsubscribe${suffix}V4`] = unsubscribe;
    agent[`resync${suffix}V4`] = resync;
    agent[`onDynamic${suffix}Frame`] = () => events[kind].listen;
  }
  return {
    agent,
    async refreshModels() {
      config = modelConfig();
      await Promise.all(
        [...subscriptions.values()]
          .filter((entry) => entry.kind === "workspace-config")
          .map((entry) => publish(entry)),
      );
    },
    taskEvents: () => workspaceEvents.listen,
    controller: {
      subscribeControllerV4: (params) => subscribe("controller", params),
      unsubscribeControllerV4: unsubscribe,
      resyncControllerV4: resync,
      onDynamicControllerFrame: () => events.controller.listen,
    },
  };
}
