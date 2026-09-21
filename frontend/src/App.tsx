import {
  Bot,
  ChevronDown,
  CircleAlert,
  Folder,
  FolderOpen,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  ApiError,
  type ApprovalDecision,
  type ApprovalRequest,
  type AgentSession,
  type AgentTurn,
  type ModelDescriptor,
  type ModelConfiguration,
  type CreateModelConfigurationInput,
  type PermissionProfile,
  type Project,
  type RuntimeEvent,
  type SessionItem,
  type SessionTokenUsage,
  type ToolInvocation,
  createModelConfiguration,
  listModelConfigurations,
} from "./api";
import { aiMeWorkspaceAdapter } from "./zcode/aiMeWorkspaceAdapter";
import {
  TurnRequestUncertainError,
  lookupTurnWithTimeout,
  reconnectDelay,
  startTurnReliably,
} from "./reliableTurnRequest";
import { MarkdownContent } from "./MarkdownContent";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { SessionUsageBar } from "./SessionUsageBar";
import { ProjectDialog } from "./ProjectDialog";
import { SessionSidebar } from "./SessionSidebar";
import { ToolStepTimeline } from "./ToolStepTimeline";

const permissionLabels: Record<PermissionProfile, string> = {
  read_only: "只读",
  workspace_write: "工作区可写",
  full_access: "完全访问",
};

// 页面业务统一通过适配层访问 AI-ME，后续替换或扩展 ZCode 服务时不改页面编排。
const {
  createSession,
  createProject,
  decideApproval,
  deleteProject,
  getActiveTurn,
  getSession,
  getSessionUsage,
  interruptTurn,
  listModels,
  listPendingApprovals,
  listProjects,
  listSessionItems,
  listSessions,
  listToolInvocations,
  streamRuntimeEvents,
  updateProject,
} = aiMeWorkspaceAdapter;

function BrandMark() {
  return <span className="brand-mark">ME</span>;
}

function itemText(item: SessionItem) {
  const value = item.type === "error" ? item.content.message : item.content.text;
  return typeof value === "string" ? value : "";
}

function App() {
  const isDesktop = window.aiMeDesktop?.mode === "desktop";
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [items, setItems] = useState<SessionItem[]>([]);
  const [draft, setDraft] = useState("");
  const [liveAnswer, setLiveAnswer] = useState("");
  const [liveAnswerCompleted, setLiveAnswerCompleted] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [modelRef, setModelRef] = useState("");
  const [permissionProfile, setPermissionProfile] =
    useState<PermissionProfile>("workspace_write");
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmingRequest, setConfirmingRequest] = useState(false);
  const [settlingRequest, setSettlingRequest] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [toolInvocations, setToolInvocations] = useState<ToolInvocation[]>([]);
  const [sessionUsage, setSessionUsage] = useState<SessionTokenUsage | null>(null);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelConfigurations, setModelConfigurations] = useState<ModelConfiguration[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSessionProject, setNewSessionProject] = useState<Project | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const liveAnswerRef = useRef("");
  const liveAnswerDrainRef = useRef<(() => void) | null>(null);
  const liveAnswerPublishRef = useRef<{
    animationFrame: number;
    fallbackTimer: number;
  } | null>(null);
  const activeSessionId = useRef<string | null>(null);
  // 会话视图版本用于隔离 A -> B -> A 场景中第一次 A 的迟到异步结果。
  const sessionViewGeneration = useRef(0);
  const pendingTurnRequests = useRef(
    new Map<string, { input: string; clientRequestId: string }>(),
  );
  const requestControllers = useRef(new Map<string, AbortController>());
  const settlingRequestKeys = useRef(new Map<string, string>());
  const timelineEnd = useRef<HTMLDivElement | null>(null);
  const projectCreateKey = useRef(crypto.randomUUID());

  useEffect(() => {
    void bootstrap();
    return () => {
      streamController.current?.abort();
      requestControllers.current.forEach((controller) => controller.abort());
      cancelLiveAnswerPublication();
      liveAnswerDrainRef.current?.();
    };
  }, []);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, liveAnswer]);

  async function bootstrap() {
    setLoading(true);
    const [projectResult, sessionResult, modelResult] = await Promise.allSettled([
        listProjects(),
        listSessions(),
        listModels(),
    ]);
    try {
      if (projectResult.status === "fulfilled") setProjects(projectResult.value);
      if (modelResult.status === "fulfilled") {
        setModels(modelResult.value);
        setModelRef(modelResult.value[0]?.ref ?? "");
      }
      if (sessionResult.status === "fulfilled") {
        setSessions(sessionResult.value);
        if (sessionResult.value[0]) await openSession(sessionResult.value[0]);
      }
      const failures = [projectResult, sessionResult, modelResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => messageFrom(result.reason));
      if (failures.length > 0) setError(failures.join("；"));
    } finally {
      setLoading(false);
    }
  }

  async function openSettings() {
    setSettingsOpen(true);
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      setModelConfigurations(await listModelConfigurations());
    } catch (reason) {
      setSettingsError(messageFrom(reason));
    } finally {
      setSettingsLoading(false);
    }
  }

  async function saveModelConfiguration(input: CreateModelConfigurationInput) {
    const configuration = await createModelConfiguration(input);
    setModelConfigurations((current) => [
      ...current.filter((item) => item.modelRef !== configuration.modelRef),
      configuration,
    ]);
    const descriptor: ModelDescriptor = {
      ref: configuration.modelRef,
      provider: configuration.provider,
      modelId: configuration.modelId,
      displayName: configuration.displayName,
      contextWindow: configuration.contextWindow,
    };
    setModels((current) => [
      ...current.filter((model) => model.ref !== descriptor.ref),
      descriptor,
    ]);
    setModelRef((current) => current || descriptor.ref);
    return configuration;
  }

  function showProjectDialog(project: Project | null) {
    setEditingProject(project);
    if (project === null) projectCreateKey.current = crypto.randomUUID();
    setProjectDialogOpen(true);
  }

  async function saveProject(input: { name: string; roots: string[] }) {
    if (editingProject) {
      await updateProject(editingProject.id, input);
    } else {
      await createProject(input, projectCreateKey.current);
    }
    setProjects(await listProjects());
    setProjectDialogOpen(false);
    setEditingProject(null);
  }

  async function removeProject(project: Project) {
    const confirmed = window.confirm(
      "删除项目后，其中的会话会移到任务，历史消息与运行记录不会删除。",
    );
    if (!confirmed) return;
    setError(null);
    try {
      await deleteProject(project.id);
      const [loadedProjects, loadedSessions] = await Promise.all([
        listProjects(),
        listSessions(),
      ]);
      setProjects(loadedProjects);
      setSessions(loadedSessions);
      setActiveSession((current) =>
        current?.projectId === project.id ? { ...current, projectId: null } : current,
      );
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }

  async function chooseProjectFolder() {
    const selected = await window.aiMeDesktop?.selectWorkspace();
    if (selected) return selected;
    if (!isDesktop) return window.prompt("输入文件夹绝对路径")?.trim() || null;
    return null;
  }

  async function openSession(session: AgentSession) {
    const viewGeneration = ++sessionViewGeneration.current;
    streamController.current?.abort();
    const previousSessionId = activeSessionId.current;
    if (previousSessionId !== null && previousSessionId !== session.id) {
      requestControllers.current.get(previousSessionId)?.abort();
    }
    activeSessionId.current = session.id;
    setActiveSession(session);
    setItems([]);
    setDraft("");
    resetLiveAnswerPresentation();
    setActiveTurnId(null);
    setApprovals([]);
    setToolInvocations([]);
    setSessionUsage(null);
    const requestInFlight = requestControllers.current.get(session.id);
    const isConfirming = requestInFlight !== undefined && !requestInFlight.signal.aborted;
    const isSettling = settlingRequestKeys.current.has(session.id);
    setConfirmingRequest(isConfirming);
    setSettlingRequest(isSettling);
    setSessionLoading(true);
    setSending(session.activity !== "idle" || isConfirming || isSettling);
    setError(null);
    try {
      const pendingRequest = pendingTurnRequests.current.get(session.id);
      const [
        freshSession,
        loadedItems,
        activeTurn,
        pendingApprovals,
        loadedInvocations,
        loadedUsage,
        reconciledTurn,
      ] = await Promise.all([
        getSession(session.id),
        listSessionItems(session.id),
        getActiveTurn(session.id),
        listPendingApprovals(session.id),
        listToolInvocations(session.id),
        getSessionUsage(session.id),
        pendingRequest && !isSettling
          ? lookupTurnWithTimeout(session.id, pendingRequest.clientRequestId)
          : Promise.resolve(null),
      ]);
      if (!isCurrentSessionView(session.id, viewGeneration)) return;
      const pendingStillCurrent =
        pendingRequest !== undefined &&
        pendingRequestMatches(session.id, pendingRequest.clientRequestId);
      if (reconciledTurn !== null && pendingStillCurrent) {
        pendingTurnRequests.current.delete(session.id);
      }
      const stillConfirming = requestControllers.current.get(session.id);
      const hasInFlightRequest =
        stillConfirming !== undefined && !stillConfirming.signal.aborted;
      const hasSettlingRequest = settlingRequestKeys.current.has(session.id);
      const needsManualReconcile =
        pendingStillCurrent &&
        reconciledTurn === null &&
        !hasInFlightRequest &&
        !hasSettlingRequest;
      setActiveSession(freshSession);
      setItems(loadedItems);
      setActiveTurnId(activeTurn?.id ?? null);
      setApprovals(pendingApprovals);
      setToolInvocations(loadedInvocations);
      setSessionUsage(loadedUsage);
      updateSidebarUsage(session.id, loadedUsage);
      setConfirmingRequest(hasInFlightRequest && activeTurn === null);
      setSettlingRequest(hasSettlingRequest);
      setSessionLoading(false);
      setSending(activeTurn !== null || hasInFlightRequest || hasSettlingRequest);
      if (needsManualReconcile) {
        setDraft(pendingRequest.input);
        setError("上次发送结果尚未确认；再次发送会沿用原请求标识安全对账");
      }
      if (activeTurn !== null) {
        void followRuntime(session.id, maxSequence(loadedItems), viewGeneration);
      }
    } catch (reason) {
      if (isCurrentSessionView(session.id, viewGeneration)) {
        const currentController = requestControllers.current.get(session.id);
        const stillConfirming =
          currentController !== undefined && !currentController.signal.aborted;
        const stillSettling = settlingRequestKeys.current.has(session.id);
        const pendingRequest = pendingTurnRequests.current.get(session.id);
        setSending(stillConfirming || stillSettling);
        setConfirmingRequest(stillConfirming);
        setSettlingRequest(stillSettling);
        setSessionLoading(false);
        if (pendingRequest && !stillConfirming && !stillSettling) {
          setDraft(pendingRequest.input);
          setError(`${messageFrom(reason)}；再次发送会沿用原请求标识安全对账`);
        } else {
          setError(messageFrom(reason));
        }
      }
    }
  }

  async function followRuntime(
    sessionId: string,
    afterSequence: number,
    viewGeneration: number,
  ) {
    // 旧视图不得中断同一会话新视图已经建立的事件流。
    if (!isCurrentSessionView(sessionId, viewGeneration)) return;
    streamController.current?.abort();
    const controller = new AbortController();
    streamController.current = controller;
    let cursor = afterSequence;
    let reconnectAttempt = 0;
    try {
      while (!controller.signal.aborted && isCurrentSessionView(sessionId, viewGeneration)) {
        try {
          await streamRuntimeEvents(
            sessionId,
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.sequence);
              handleRuntimeEvent(sessionId, viewGeneration, event);
            },
            controller.signal,
          );
          reconnectAttempt = 0;
        } catch (reason) {
          if (controller.signal.aborted || !isCurrentSessionView(sessionId, viewGeneration)) {
            return;
          }
          reconnectAttempt += 1;
          setError(`事件流暂时断开，正在恢复（第 ${reconnectAttempt} 次）…`);
          await reconnectDelay(controller.signal, reconnectAttempt);
          if (controller.signal.aborted || !isCurrentSessionView(sessionId, viewGeneration)) {
            return;
          }
        }

        try {
          const [
            updatedSession,
            updatedItems,
            activeTurn,
            pendingApprovals,
            updatedInvocations,
            updatedUsage,
            updatedSessions,
          ] = await Promise.all([
            getSession(sessionId),
            listSessionItems(sessionId),
            getActiveTurn(sessionId),
            listPendingApprovals(sessionId),
            listToolInvocations(sessionId),
            getSessionUsage(sessionId),
            listSessions(),
          ]);
          if (!isCurrentSessionView(sessionId, viewGeneration)) return;
          setActiveSession(updatedSession);
          setSessions(updatedSessions);
          setApprovals(pendingApprovals);
          setToolInvocations(updatedInvocations);
          setSessionUsage(updatedUsage);
          if (activeTurn === null) {
            setActiveTurnId(null);
            if (liveAnswerRef.current) {
              setSending(true);
              await waitForLiveAnswerPresentation();
              if (!isCurrentSessionView(sessionId, viewGeneration)) return;
            }
            setItems(updatedItems);
            resetLiveAnswerPresentation();
            setSending(false);
            setError(null);
            return;
          }
          setItems(updatedItems);
          setActiveTurnId(activeTurn.id);
          setSending(true);
          setError(null);
        } catch (reason) {
          if (controller.signal.aborted || !isCurrentSessionView(sessionId, viewGeneration)) {
            return;
          }
          reconnectAttempt += 1;
          setError(`本地 Runtime 暂时不可达，正在恢复：${messageFrom(reason)}`);
          await reconnectDelay(controller.signal, reconnectAttempt);
          if (controller.signal.aborted || !isCurrentSessionView(sessionId, viewGeneration)) {
            return;
          }
        }
      }
    } finally {
      if (streamController.current === controller) streamController.current = null;
    }
  }

  function handleRuntimeEvent(
    sessionId: string,
    viewGeneration: number,
    event: RuntimeEvent,
  ) {
    if (!isCurrentSessionView(sessionId, viewGeneration)) {
      return;
    }
    if (event.type === "approval_required") {
      void refreshRuntimeFacts(sessionId, viewGeneration);
      return;
    }
    if (event.type.startsWith("tool_")) {
      void refreshRuntimeFacts(sessionId, viewGeneration);
      return;
    }
    if (event.type === "model_usage") {
      void refreshSessionUsage(sessionId, viewGeneration);
      return;
    }
    if (event.type !== "text_delta") return;
    setActiveTurnId(event.turnId);
    const text = event.payload.text;
    if (typeof text === "string") {
      liveAnswerRef.current += text;
      scheduleLiveAnswerPublication();
    }
  }

  function waitForLiveAnswerPresentation() {
    flushLiveAnswerPublication();
    setLiveAnswerCompleted(true);
    return new Promise<void>((resolve) => {
      liveAnswerDrainRef.current = () => {
        liveAnswerDrainRef.current = null;
        resolve();
      };
    });
  }

  function resetLiveAnswerPresentation() {
    cancelLiveAnswerPublication();
    liveAnswerDrainRef.current?.();
    liveAnswerDrainRef.current = null;
    liveAnswerRef.current = "";
    setLiveAnswer("");
    setLiveAnswerCompleted(false);
  }

  function scheduleLiveAnswerPublication() {
    if (liveAnswerPublishRef.current !== null) return;
    let published = false;
    const publish = () => {
      if (published) return;
      published = true;
      cancelLiveAnswerPublication();
      setLiveAnswer(liveAnswerRef.current);
    };
    const pending = { animationFrame: 0, fallbackTimer: 0 };
    liveAnswerPublishRef.current = pending;
    pending.animationFrame = requestAnimationFrame(publish);
    // 后台窗口可能暂停动画帧，100ms 兜底保证文本仍持续可见。
    pending.fallbackTimer = window.setTimeout(publish, 100);
  }

  function flushLiveAnswerPublication() {
    if (liveAnswerPublishRef.current === null) return;
    cancelLiveAnswerPublication();
    setLiveAnswer(liveAnswerRef.current);
  }

  function cancelLiveAnswerPublication() {
    const pending = liveAnswerPublishRef.current;
    if (pending === null) return;
    cancelAnimationFrame(pending.animationFrame);
    window.clearTimeout(pending.fallbackTimer);
    liveAnswerPublishRef.current = null;
  }

  async function refreshRuntimeFacts(sessionId: string, viewGeneration: number) {
    try {
      const [pendingApprovals, invocations, session] = await Promise.all([
        listPendingApprovals(sessionId),
        listToolInvocations(sessionId),
        getSession(sessionId),
      ]);
      if (!isCurrentSessionView(sessionId, viewGeneration)) return;
      setApprovals(pendingApprovals);
      setToolInvocations(invocations);
      setActiveSession(session);
    } catch (reason) {
      if (isCurrentSessionView(sessionId, viewGeneration)) setError(messageFrom(reason));
    }
  }

  async function refreshSessionUsage(sessionId: string, viewGeneration: number) {
    try {
      const usage = await getSessionUsage(sessionId);
      if (isCurrentSessionView(sessionId, viewGeneration)) {
        setSessionUsage(usage);
        updateSidebarUsage(sessionId, usage);
      }
    } catch (reason) {
      if (isCurrentSessionView(sessionId, viewGeneration)) setError(messageFrom(reason));
    }
  }

  function updateSidebarUsage(sessionId: string, usage: SessionTokenUsage) {
    const sessionModel = sessions.find((session) => session.id === sessionId)?.defaultModel;
    const contextWindow = usage.contextWindow
      ?? models.find((model) => model.ref === sessionModel)?.contextWindow
      ?? null;
    const current = usage.currentContextTokens;
    const percentage =
      current !== null && contextWindow !== null && contextWindow > 0
        ? Math.min(100, Math.round((current / contextWindow) * 100))
        : null;
    setSessions((items) => items.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            contextUsage: {
              currentContextTokens: current,
              contextWindow,
              percentage,
              partial: usage.unreportedSteps > 0 || usage.untrackedHistory,
            },
          }
        : session,
    ));
  }

  async function resolveApproval(approval: ApprovalRequest, decision: ApprovalDecision) {
    if (!activeSession || decidingApprovalId) return;
    const sessionId = activeSession.id;
    const viewGeneration = sessionViewGeneration.current;
    setDecidingApprovalId(approval.id);
    setError(null);
    try {
      await decideApproval(sessionId, approval.id, decision);
      if (!isCurrentSessionView(sessionId, viewGeneration)) return;
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
      setActiveSession((current) =>
        current && current.id === sessionId ? { ...current, activity: "running" } : current,
      );
    } catch (reason) {
      if (isCurrentSessionView(sessionId, viewGeneration)) setError(messageFrom(reason));
    } finally {
      if (isCurrentSessionView(sessionId, viewGeneration)) setDecidingApprovalId(null);
    }
  }

  async function submitTurn() {
    if (!activeSession || sending || sessionLoading || !draft.trim()) return;
    const sessionId = activeSession.id;
    const viewGeneration = sessionViewGeneration.current;
    const instruction = draft.trim();
    const cursor = maxSequence(items);
    setDraft("");
    resetLiveAnswerPresentation();
    setSending(true);
    setConfirmingRequest(true);
    setSettlingRequest(false);
    setError(null);
    const previousRequest = pendingTurnRequests.current.get(sessionId);
    const request =
      previousRequest?.input === instruction
        ? previousRequest
        : { input: instruction, clientRequestId: crypto.randomUUID() };
    pendingTurnRequests.current.set(sessionId, request);
    const requestController = new AbortController();
    requestControllers.current.get(sessionId)?.abort();
    requestControllers.current.set(sessionId, requestController);
    let turn: AgentTurn;
    try {
      turn = await startTurnReliably(
        sessionId,
        instruction,
        request.clientRequestId,
        requestController.signal,
        (attempt) => {
          if (isCurrentSessionView(sessionId, viewGeneration)) {
            setError(`发送结果暂未确认，正在使用同一请求标识对账（第 ${attempt} 次）…`);
          }
        },
      );
      pendingTurnRequests.current.delete(sessionId);
    } catch (reason) {
      if (requestController.signal.aborted) return;
      const isUncertain = reason instanceof TurnRequestUncertainError;
      if (!isUncertain) pendingTurnRequests.current.delete(sessionId);
      if (isCurrentSessionView(sessionId, viewGeneration)) {
        setDraft(instruction);
        setSending(false);
        setConfirmingRequest(false);
        setError(messageFrom(reason));
      }
      return;
    } finally {
      if (requestControllers.current.get(sessionId) === requestController) {
        requestControllers.current.delete(sessionId);
      }
    }
    if (!isCurrentSessionView(sessionId, viewGeneration)) return;

    setConfirmingRequest(false);
    setActiveTurnId(turn.id);
    setActiveSession({
      ...activeSession,
      activity: turn.status === "queued" ? "queued" : "running",
    });
    try {
      const loadedItems = await listSessionItems(sessionId);
      if (!isCurrentSessionView(sessionId, viewGeneration)) return;
      setItems(loadedItems);
    } catch (reason) {
      // Turn 已被服务端接受，此处只提示投影刷新失败，不能把消息恢复成可重复发送状态。
      if (isCurrentSessionView(sessionId, viewGeneration)) setError(messageFrom(reason));
    }
    if (isCurrentSessionView(sessionId, viewGeneration)) {
      void followRuntime(sessionId, cursor, viewGeneration);
    }
  }

  async function stopTurn() {
    if (!activeSession) return;
    if (!activeTurnId) {
      if (confirmingRequest) await cancelPendingTurnRequest(activeSession.id);
      return;
    }
    const sessionId = activeSession.id;
    const viewGeneration = sessionViewGeneration.current;
    try {
      await interruptTurn(sessionId, activeTurnId);
    } catch (reason) {
      if (isCurrentSessionView(sessionId, viewGeneration)) setError(messageFrom(reason));
    }
  }

  async function cancelPendingTurnRequest(sessionId: string) {
    // 停止自动重试，并做最后一次只读对账；未知结果仍保留原幂等键。
    const pendingRequest = pendingTurnRequests.current.get(sessionId);
    if (!pendingRequest) return;
    const requestKey = pendingRequest.clientRequestId;
    const viewGeneration = sessionViewGeneration.current;
    settlingRequestKeys.current.set(sessionId, requestKey);
    requestControllers.current.get(sessionId)?.abort();
    requestControllers.current.delete(sessionId);
    if (isCurrentSessionView(sessionId, viewGeneration)) {
      setConfirmingRequest(false);
      setSettlingRequest(true);
      setSending(true);
      setError("已停止自动重试，正在确认服务端是否已接受请求…");
    }

    let acceptedTurn: AgentTurn | null = null;
    try {
      acceptedTurn = await lookupTurnWithTimeout(
        sessionId,
        pendingRequest.clientRequestId,
      );
    } catch (reason) {
      clearSettlingRequest(sessionId, requestKey);
      if (!pendingRequestMatches(sessionId, requestKey)) return;
      if (isCurrentSessionView(sessionId, viewGeneration)) {
        setDraft(pendingRequest.input);
        setSettlingRequest(false);
        setSending(false);
        setError("自动重试已停止；结果仍未确认，再次发送会使用原请求标识继续对账");
      } else if (activeSessionId.current === sessionId) {
        void reopenCurrentSessionAfterSettlement(sessionId);
      }
      return;
    }
    if (!pendingRequestMatches(sessionId, requestKey)) {
      clearSettlingRequest(sessionId, requestKey);
      if (activeSessionId.current === sessionId) {
        void reopenCurrentSessionAfterSettlement(sessionId);
      }
      return;
    }
    if (acceptedTurn === null) {
      clearSettlingRequest(sessionId, requestKey);
      if (isCurrentSessionView(sessionId, viewGeneration)) {
        setDraft(pendingRequest.input);
        setSettlingRequest(false);
        setSending(false);
        setError("自动重试已停止；再次发送会使用原请求标识确认，不会重复执行");
      } else if (activeSessionId.current === sessionId) {
        void reopenCurrentSessionAfterSettlement(sessionId);
      }
      return;
    }

    if (pendingRequestMatches(sessionId, requestKey)) {
      pendingTurnRequests.current.delete(sessionId);
    }
    let freshSession: AgentSession;
    let loadedItems: SessionItem[];
    let activeTurn: AgentTurn | null;
    try {
      [freshSession, loadedItems, activeTurn] = await Promise.all([
        getSession(sessionId),
        listSessionItems(sessionId),
        getActiveTurn(sessionId),
      ]);
    } catch (reason) {
      clearSettlingRequest(sessionId, requestKey);
      if (isCurrentSessionView(sessionId, viewGeneration)) {
        setSettlingRequest(false);
        const acceptedIsActive = ["queued", "in_progress", "waiting_for_user"].includes(
          acceptedTurn.status,
        );
        setActiveTurnId(acceptedIsActive ? acceptedTurn.id : null);
        setSending(acceptedIsActive);
        setError(`请求已被接受，但会话刷新失败：${messageFrom(reason)}`);
        if (acceptedIsActive) {
          void followRuntime(sessionId, maxSequence(items), viewGeneration);
        }
      } else if (activeSessionId.current === sessionId) {
        void reopenCurrentSessionAfterSettlement(sessionId);
      }
      return;
    }
    clearSettlingRequest(sessionId, requestKey);
    if (
      !isCurrentSessionView(sessionId, viewGeneration) ||
      pendingTurnRequests.current.has(sessionId)
    ) {
      if (activeSessionId.current === sessionId) {
        void reopenCurrentSessionAfterSettlement(sessionId);
      }
      return;
    }
    setActiveSession(freshSession);
    setItems(loadedItems);
    setActiveTurnId(activeTurn?.id ?? null);
    setSettlingRequest(false);
    setSending(activeTurn !== null);
    setError(null);
    if (activeTurn !== null) {
      void followRuntime(sessionId, maxSequence(loadedItems), viewGeneration);
    }
  }

  function pendingRequestMatches(sessionId: string, clientRequestId: string) {
    return pendingTurnRequests.current.get(sessionId)?.clientRequestId === clientRequestId;
  }

  function clearSettlingRequest(sessionId: string, clientRequestId: string) {
    if (settlingRequestKeys.current.get(sessionId) === clientRequestId) {
      settlingRequestKeys.current.delete(sessionId);
    }
  }

  async function reopenCurrentSessionAfterSettlement(sessionId: string) {
    // 对账所有权仍属于发起取消的流程；新视图只在对账结束后整体重载一次。
    const viewGeneration = sessionViewGeneration.current;
    if (!isCurrentSessionView(sessionId, viewGeneration)) return;
    try {
      const freshSession = await getSession(sessionId);
      if (!isCurrentSessionView(sessionId, viewGeneration)) return;
      await openSession(freshSession);
    } catch (reason) {
      if (!isCurrentSessionView(sessionId, viewGeneration)) return;
      const pendingRequest = pendingTurnRequests.current.get(sessionId);
      setDraft(pendingRequest?.input ?? "");
      setConfirmingRequest(false);
      setSettlingRequest(false);
      setSending(false);
      setSessionLoading(false);
      setError(`对账已结束，但会话刷新失败：${messageFrom(reason)}`);
    }
  }

  function isCurrentSessionView(sessionId: string, viewGeneration: number) {
    return (
      activeSessionId.current === sessionId &&
      sessionViewGeneration.current === viewGeneration
    );
  }

  async function submitSession() {
    if ((!newSessionProject && !workspacePath.trim()) || !modelRef || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createSession(
        newSessionProject
          ? {
              projectId: newSessionProject.id,
              defaultModel: modelRef,
              permissionProfile,
            }
          : {
              workspacePath: workspacePath.trim(),
              defaultModel: modelRef,
              permissionProfile,
            },
      );
      setSessions(await listSessions());
      setWorkspacePath("");
      setNewSessionProject(null);
      await openSession(created);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setCreating(false);
    }
  }

  async function chooseWorkspace() {
    const selected = await window.aiMeDesktop?.selectWorkspace();
    if (selected) setWorkspacePath(selected);
  }

  function showNewSession(project: Project | null = null) {
    sessionViewGeneration.current += 1;
    streamController.current?.abort();
    const previousSessionId = activeSessionId.current;
    if (previousSessionId !== null) requestControllers.current.get(previousSessionId)?.abort();
    activeSessionId.current = null;
    setActiveSession(null);
    setItems([]);
    setDraft("");
    resetLiveAnswerPresentation();
    setActiveTurnId(null);
    setSessionUsage(null);
    setConfirmingRequest(false);
    setSettlingRequest(false);
    setSessionLoading(false);
    setSending(false);
    setError(null);
    setNewSessionProject(project);
    if (project === null) setWorkspacePath("");
  }

  return (
    <div className={`agent-shell zcode-shell ${isDesktop ? "is-desktop" : "is-web"}`}>
      {isDesktop ? (
        <div className="window-bar">
          <div className="window-brand"><BrandMark /><strong>AI-ME</strong><span>alpha</span></div>
          <div className="window-drag-title">本地 Agent 工作台</div>
        </div>
      ) : null}

      <aside className="session-sidebar zcode-sidebar">
        <div className="sidebar-head zcode-sidebar-head">
          {!isDesktop ? <div className="web-brand"><BrandMark /><strong>AI-ME</strong><span className="zcode-product-badge">WORKSPACE</span></div> : null}
          <button className="zcode-workspace-switcher" type="button" aria-label="选择工作区">
            <span className="zcode-workspace-icon"><Folder size={14} /></span>
            <span><strong>本地工作区</strong><small>AI-ME Runtime</small></span>
            <ChevronDown size={14} />
          </button>
          <button className="new-session-button" type="button" onClick={() => showNewSession()}>
            <Plus size={16} /> 新建任务
          </button>
        </div>

        <SessionSidebar
          projects={projects}
          sessions={sessions}
          activeSessionId={activeSession?.id ?? null}
          loading={loading}
          onOpenSession={(session) => void openSession(session)}
          onCreateProject={() => showProjectDialog(null)}
          onEditProject={(project) => showProjectDialog(project)}
          onDeleteProject={(project) => void removeProject(project)}
          onCreateSession={(project) => showNewSession(project)}
        />

        <div className="sidebar-foot zcode-sidebar-foot">
          <div className="runtime-state">
            <span className="runtime-orb"><Bot size={15} /></span>
            <span><strong>本地 Runtime</strong><small>数据保存在这台电脑</small></span>
            <span className="online-dot" />
          </div>
          <button className="settings-row" type="button" onClick={() => void openSettings()}>
            <Settings size={15} /> 设置
          </button>
        </div>
      </aside>

      <main className="conversation-workspace zcode-main">
        {activeSession ? (
          <>
            <header className="conversation-header zcode-topbar">
              <div><h1>{activeSession.title}</h1><p><Folder size={13} /> {activeSession.workspacePath}</p></div>
              <div className="session-facts">
                <span>{activeSession.defaultModel}</span>
                <span><ShieldCheck size={13} /> {permissionLabels[activeSession.permissionProfile]}</span>
                <button type="button" aria-label="会话菜单"><ChevronDown size={15} /></button>
              </div>
            </header>

            <section className="timeline zcode-timeline" aria-live="polite">
              {items.length === 0 && !liveAnswer && !sessionLoading ? (
                <div className="conversation-empty">
                  <span className="empty-agent"><Sparkles size={22} /></span>
                  <h2>从一个清楚的任务开始</h2>
                  <p>说明目标、范围和你希望保留的边界。AI-ME 会在这个工作区内持续完成后续轮次。</p>
                </div>
              ) : null}
              <div className="message-stack">
                {items.map((item) => (
                  <Fragment key={item.id}>
                    <MessageItem item={item} />
                    {item.type === "user_message"
                      ? <ToolStepTimeline
                          invocations={toolInvocations.filter(
                            (invocation) => invocation.turnId === item.turnId,
                          )}
                        />
                      : null}
                  </Fragment>
                ))}
                {approvals.length === 0 &&
                (liveAnswer || (sending && !confirmingRequest && !settlingRequest)) ? (
                  <LiveMessage
                    text={liveAnswer}
                    completed={liveAnswerCompleted}
                    onSettled={() => liveAnswerDrainRef.current?.()}
                  />
                ) : null}
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    deciding={decidingApprovalId === approval.id}
                    onDecision={(decision) => void resolveApproval(approval, decision)}
                  />
                ))}
                <div ref={timelineEnd} />
              </div>
            </section>

            <footer className="composer-zone zcode-composer-zone">
              {error ? <div className="inline-error"><CircleAlert size={14} />{error}</div> : null}
              <SessionUsageBar
                usage={sessionUsage}
                fallbackContextWindow={
                  models.find((model) => model.ref === activeSession.defaultModel)?.contextWindow
                  ?? null
                }
              />
              <div className="composer">
                <textarea
                  aria-label="给 AI-ME 发消息"
                  placeholder="描述你希望 AI-ME 完成的任务…"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submitTurn();
                    }
                  }}
                  disabled={sending || sessionLoading}
                  rows={3}
                />
                <div className="composer-foot">
                  <span>
                    {settlingRequest
                      ? "正在完成发送结果的最终对账"
                      : confirmingRequest
                      ? "正在确认请求是否已被本地 Runtime 接受"
                      : liveAnswerCompleted
                        ? "正在完成回答的平滑显示"
                      : sending
                        ? "Agent 正在执行当前 Turn"
                        : "Enter 发送 · Shift + Enter 换行"}
                  </span>
                  <button
                    className={`send-button${sending ? " stop" : ""}`}
                    type="button"
                    onClick={() => sending ? void stopTurn() : void submitTurn()}
                    disabled={
                      sessionLoading ||
                      settlingRequest ||
                      (sending ? !activeTurnId && !confirmingRequest : !draft.trim())
                    }
                    aria-label={
                      settlingRequest
                        ? "正在对账"
                        : confirmingRequest
                          ? "停止确认"
                          : liveAnswerCompleted
                            ? "正在完成显示"
                          : sending
                            ? "中断"
                            : "发送"
                    }
                  >{sending ? <Square size={13} fill="currentColor" /> : <Send size={16} />}</button>
                </div>
              </div>
            </footer>
          </>
        ) : (
          <NewSessionPanel
            error={error}
            isDesktop={isDesktop}
            models={models}
            workspacePath={workspacePath}
            modelRef={modelRef}
            permissionProfile={permissionProfile}
            creating={creating}
            project={newSessionProject}
            onWorkspaceChange={setWorkspacePath}
            onChooseWorkspace={() => void chooseWorkspace()}
            onModelChange={setModelRef}
            onPermissionChange={setPermissionProfile}
            onSubmit={() => void submitSession()}
            onOpenSettings={() => void openSettings()}
          />
        )}
      </main>

      {settingsOpen ? (
        <ModelSettingsDialog
          configurations={modelConfigurations}
          loading={settingsLoading}
          loadError={settingsError}
          onClose={() => setSettingsOpen(false)}
          onCreate={saveModelConfiguration}
        />
      ) : null}
      <ProjectDialog
        open={projectDialogOpen}
        project={editingProject}
        onClose={() => setProjectDialogOpen(false)}
        onChooseFolder={chooseProjectFolder}
        onSave={saveProject}
      />
    </div>
  );
}

function MessageItem({ item }: { item: SessionItem }) {
  const role = item.type === "user_message" ? "user" : item.type === "error" ? "error" : "agent";
  const text = itemText(item);
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{role === "user" ? "你" : <Bot size={16} />}</div>
      <div className="message-body">
        <span className="message-author">{role === "user" ? "你" : role === "error" ? "运行中断" : "AI-ME"}</span>
        {role === "agent" ? <MarkdownContent text={text} /> : <p>{text}</p>}
      </div>
    </article>
  );
}

function LiveMessage({
  text,
  completed,
  onSettled,
}: {
  text: string;
  completed: boolean;
  onSettled: () => void;
}) {
  return (
    <article className="message agent live">
      <div className="message-avatar"><Bot size={16} /></div>
      <div className="message-body">
        <span className="message-author">AI-ME <i>{completed ? "正在完成" : "正在生成"}</i></span>
        {text ? (
          <StreamingMarkdown text={text} completed={completed} onSettled={onSettled} />
        ) : (
          <div className="typing"><span /><span /><span /></div>
        )}
      </div>
    </article>
  );
}

function ApprovalCard({
  approval,
  deciding,
  onDecision,
}: {
  approval: ApprovalRequest;
  deciding: boolean;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  return (
    <section className="approval-card" aria-label="工具执行需要确认">
      <div className="approval-heading">
        <span className="approval-icon"><ShieldCheck size={17} /></span>
        <div>
          <strong>工具执行需要你的确认</strong>
          <small>{approval.toolName}</small>
        </div>
      </div>
      <p>{approval.reason}</p>
      <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
      <div className="approval-actions">
        <button type="button" disabled={deciding} onClick={() => onDecision("reject")}>
          拒绝
        </button>
        <button type="button" disabled={deciding} onClick={() => onDecision("approve_once")}>
          仅本次允许
        </button>
        <button
          className="primary"
          type="button"
          disabled={deciding}
          onClick={() => onDecision("approve_session")}
        >
          {deciding ? "正在处理…" : "本会话允许"}
        </button>
      </div>
    </section>
  );
}

interface NewSessionPanelProps {
  error: string | null;
  isDesktop: boolean;
  models: ModelDescriptor[];
  workspacePath: string;
  modelRef: string;
  permissionProfile: PermissionProfile;
  creating: boolean;
  project: Project | null;
  onWorkspaceChange: (value: string) => void;
  onChooseWorkspace: () => void;
  onModelChange: (value: string) => void;
  onPermissionChange: (value: PermissionProfile) => void;
  onSubmit: () => void;
  onOpenSettings: () => void;
}

function NewSessionPanel(props: NewSessionPanelProps) {
  const canCreate = Boolean(
    (props.project || props.workspacePath.trim()) && props.modelRef && !props.creating,
  );
  return (
    <section className="new-session-view zcode-welcome">
      <div className="new-session-card zcode-welcome-card">
        <div className="zcode-welcome-intro">
          <span className="new-session-mark"><Bot size={25} /></span>
          <span className="zcode-welcome-kicker">NEW TASK</span>
        </div>
        <div className="new-session-heading">
          <span>{props.project ? "PROJECT WORKSPACE" : "LOCAL WORKSPACE"}</span>
          <h1>{props.project ? `在 ${props.project.name} 中开始任务` : "你想让 AI-ME 完成什么？"}</h1>
          <p>
            {props.project
              ? "选择模型和权限后，AI-ME 会在这个项目工作区内执行任务。"
              : "选择一个本地工作区，AI-ME 会在这里持续完成任务并保留完整执行轨迹。"}
          </p>
        </div>

        <div className="session-form">
          {props.project ? (
            <div className="session-project-roots" role="group" aria-label={`${props.project.name} 会话目录`}>
              <span>项目目录</span>
              {props.project.roots.map((root) => (
                <div key={root.path} title={root.path}>
                  <FolderOpen size={14} />
                  <span>{root.path}</span>
                  {root.primary ? <em>主要</em> : null}
                </div>
              ))}
            </div>
          ) : (
            <label>
              <span>工作区</span>
              <div className="workspace-field">
                <FolderOpen size={16} />
                <input
                  aria-label="独立会话工作区"
                  value={props.workspacePath}
                  onChange={(event) => props.onWorkspaceChange(event.target.value)}
                  placeholder="选择或输入一个已存在的目录"
                />
                {props.isDesktop ? <button type="button" onClick={props.onChooseWorkspace}>选择</button> : null}
              </div>
            </label>
          )}

          <div className="form-grid">
            <label>
              <span>模型</span>
              <select value={props.modelRef} onChange={(event) => props.onModelChange(event.target.value)}>
                {props.models.length === 0 ? <option value="">未检测到已配置模型</option> : null}
                {props.models.map((model) => <option value={model.ref} key={model.ref}>{model.displayName}</option>)}
              </select>
            </label>
            <label>
              <span>权限</span>
              <select
                value={props.permissionProfile}
                onChange={(event) => props.onPermissionChange(event.target.value as PermissionProfile)}
              >
                <option value="read_only">只读</option>
                <option value="workspace_write">工作区可写</option>
                <option value="full_access">完全访问</option>
              </select>
            </label>
          </div>
        </div>

        {props.models.length === 0 ? (
          <p className="model-guidance">
            还没有可用模型。<button type="button" onClick={props.onOpenSettings}>打开模型设置</button>
            ，保存后即可创建会话。
          </p>
        ) : null}
        {props.error ? <div className="inline-error"><CircleAlert size={14} />{props.error}</div> : null}
        <button className="create-session-button" type="button" disabled={!canCreate} onClick={props.onSubmit}>
          {props.creating ? "正在创建…" : "创建会话"}<Send size={15} />
        </button>
      </div>
    </section>
  );
}

type ModelPresetId = "deepseek" | "openai" | "anthropic" | "custom";

interface ModelPreset {
  provider: string;
  modelId: string;
  displayName: string;
  protocol: CreateModelConfigurationInput["protocol"];
  baseUrl: string;
  contextWindow: number;
}

const modelPresets: Record<ModelPresetId, ModelPreset> = {
  deepseek: {
    provider: "deepseek",
    modelId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    protocol: "openai_completions",
    baseUrl: "https://api.deepseek.com/v1",
    contextWindow: 128000,
  },
  openai: {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    protocol: "openai_completions",
    baseUrl: "",
    contextWindow: 128000,
  },
  anthropic: {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    protocol: "anthropic_messages",
    baseUrl: "",
    contextWindow: 200000,
  },
  custom: {
    provider: "custom",
    modelId: "",
    displayName: "",
    protocol: "openai_completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    contextWindow: 128000,
  },
};

function ModelSettingsDialog({
  configurations,
  loading,
  loadError,
  onClose,
  onCreate,
}: {
  configurations: ModelConfiguration[];
  loading: boolean;
  loadError: string | null;
  onClose: () => void;
  onCreate: (input: CreateModelConfigurationInput) => Promise<ModelConfiguration>;
}) {
  const [presetId, setPresetId] = useState<ModelPresetId>("deepseek");
  const [form, setForm] = useState<ModelPreset>(modelPresets.deepseek);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function choosePreset(value: ModelPresetId) {
    setPresetId(value);
    setForm(modelPresets[value]);
    setFormError(null);
    setSuccess(null);
  }

  function updateForm<K extends keyof ModelPreset>(key: K, value: ModelPreset[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setSuccess(null);
    try {
      const saved = await onCreate({
        provider: form.provider,
        modelId: form.modelId,
        displayName: form.displayName,
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim() || null,
        apiKey,
        contextWindow: form.contextWindow,
      });
      setApiKey("");
      setSuccess(`${saved.displayName} 已可用于新会话`);
    } catch (reason) {
      setFormError(messageFrom(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-overlay" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
        <header>
          <div>
            <small>LOCAL MODEL ACCESS</small>
            <h2 id="model-settings-title">模型配置</h2>
            <p>新增模型后立即生效，不需要环境变量或重启应用。</p>
          </div>
          <button type="button" aria-label="关闭设置" onClick={onClose}><X size={17} /></button>
        </header>

        <div className="settings-content">
          <div className="configured-models">
            <h3>已配置模型</h3>
            {loading ? <p>正在读取本机配置…</p> : null}
            {!loading && configurations.length === 0 ? <p>还没有通过设置添加模型。</p> : null}
            {configurations.map((configuration) => (
              <div className="configured-model-row" key={configuration.id}>
                <span><strong>{configuration.displayName}</strong><small>{configuration.modelRef}</small></span>
                <i className={configuration.credentialStored ? "available" : ""}>
                  {configuration.credentialStored ? "可用" : "密钥缺失"}
                </i>
              </div>
            ))}
            {loadError ? <div className="inline-error"><CircleAlert size={14} />{loadError}</div> : null}
          </div>

          <form className="model-config-form" onSubmit={(event) => void submit(event)}>
            <h3>新增模型</h3>
            <label>
              <span>服务商预设</span>
              <select value={presetId} onChange={(event) => choosePreset(event.target.value as ModelPresetId)}>
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">OpenAI 兼容服务</option>
              </select>
            </label>
            <div className="settings-form-grid">
              <label>
                <span>厂商标识</span>
                <input value={form.provider} onChange={(event) => updateForm("provider", event.target.value)} required />
              </label>
              <label>
                <span>协议</span>
                <select value={form.protocol} onChange={(event) => updateForm("protocol", event.target.value as ModelPreset["protocol"])}>
                  <option value="openai_completions">OpenAI Chat Completions</option>
                  <option value="anthropic_messages">Anthropic Messages</option>
                </select>
              </label>
              <label>
                <span>模型 ID</span>
                <input value={form.modelId} onChange={(event) => updateForm("modelId", event.target.value)} required />
              </label>
              <label>
                <span>显示名称</span>
                <input value={form.displayName} onChange={(event) => updateForm("displayName", event.target.value)} required />
              </label>
            </div>
            <label>
              <span>API 地址 <i>官方地址可留空</i></span>
              <input value={form.baseUrl} onChange={(event) => updateForm("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" />
            </label>
            <div className="settings-form-grid api-key-row">
              <label>
                <span>API Key</span>
                <input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
              </label>
              <label>
                <span>上下文窗口</span>
                <input type="number" min="1" max="10000000" value={form.contextWindow} onChange={(event) => updateForm("contextWindow", Number(event.target.value))} required />
              </label>
            </div>
            <p className="credential-note"><ShieldCheck size={14} />API Key 保存到 Windows 凭据保险库，页面和接口均不会再次显示明文。</p>
            {formError ? <div className="inline-error"><CircleAlert size={14} />{formError}</div> : null}
            {success ? <p className="settings-success">{success}</p> : null}
            <button className="save-model-button" type="submit" disabled={saving}>
              {saving ? "正在保存…" : "保存并启用"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function maxSequence(items: SessionItem[]) {
  return items.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
}

function messageFrom(reason: unknown) {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return "发生了未知错误";
}

export default App;
