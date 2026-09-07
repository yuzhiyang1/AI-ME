import {
  Bot,
  ChevronDown,
  CircleAlert,
  Folder,
  FolderOpen,
  MessageSquare,
  PanelLeft,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  ApiError,
  type ApprovalDecision,
  type ApprovalRequest,
  type AgentSession,
  type AgentTurn,
  type ModelDescriptor,
  type PermissionProfile,
  type RuntimeEvent,
  type SessionItem,
  type ToolInvocation,
  createSession,
  decideApproval,
  getActiveTurn,
  getSession,
  interruptTurn,
  listModels,
  listPendingApprovals,
  listSessionItems,
  listSessions,
  listToolInvocations,
  streamRuntimeEvents,
} from "./api";
import {
  TurnRequestUncertainError,
  lookupTurnWithTimeout,
  reconnectDelay,
  startTurnReliably,
} from "./reliableTurnRequest";

const permissionLabels: Record<PermissionProfile, string> = {
  read_only: "只读",
  workspace_write: "工作区可写",
  full_access: "完全访问",
};

function BrandMark() {
  return <span className="brand-mark">ME</span>;
}

function shortWorkspace(path: string) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function itemText(item: SessionItem) {
  const value = item.type === "error" ? item.content.message : item.content.text;
  return typeof value === "string" ? value : "";
}

function App() {
  const isDesktop = window.aiMeDesktop?.mode === "desktop";
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [items, setItems] = useState<SessionItem[]>([]);
  const [draft, setDraft] = useState("");
  const [liveAnswer, setLiveAnswer] = useState("");
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
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const activeSessionId = useRef<string | null>(null);
  // 会话视图版本用于隔离 A -> B -> A 场景中第一次 A 的迟到异步结果。
  const sessionViewGeneration = useRef(0);
  const pendingTurnRequests = useRef(
    new Map<string, { input: string; clientRequestId: string }>(),
  );
  const requestControllers = useRef(new Map<string, AbortController>());
  const settlingRequestKeys = useRef(new Map<string, string>());
  const timelineEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void bootstrap();
    return () => {
      streamController.current?.abort();
      requestControllers.current.forEach((controller) => controller.abort());
    };
  }, []);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, liveAnswer]);

  async function bootstrap() {
    setLoading(true);
    try {
      const [loadedSessions, loadedModels] = await Promise.all([listSessions(), listModels()]);
      setSessions(loadedSessions);
      setModels(loadedModels);
      setModelRef(loadedModels[0]?.ref ?? "");
      if (loadedSessions[0]) {
        await openSession(loadedSessions[0]);
      }
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
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
    setLiveAnswer("");
    setActiveTurnId(null);
    setApprovals([]);
    setToolInvocations([]);
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
        reconciledTurn,
      ] = await Promise.all([
        getSession(session.id),
        listSessionItems(session.id),
        getActiveTurn(session.id),
        listPendingApprovals(session.id),
        listToolInvocations(session.id),
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
            updatedSessions,
          ] = await Promise.all([
            getSession(sessionId),
            listSessionItems(sessionId),
            getActiveTurn(sessionId),
            listPendingApprovals(sessionId),
            listToolInvocations(sessionId),
            listSessions(),
          ]);
          if (!isCurrentSessionView(sessionId, viewGeneration)) return;
          setActiveSession(updatedSession);
          setItems(updatedItems);
          setSessions(updatedSessions);
          setActiveTurnId(activeTurn?.id ?? null);
          setApprovals(pendingApprovals);
          setToolInvocations(updatedInvocations);
          setSending(activeTurn !== null);
          if (activeTurn === null) {
            setLiveAnswer("");
            setError(null);
            return;
          }
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
    if (event.type !== "text_delta") return;
    setActiveTurnId(event.turnId);
    const text = event.payload.text;
    if (typeof text === "string") setLiveAnswer((current) => current + text);
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
    setLiveAnswer("");
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
    if (!workspacePath.trim() || !modelRef || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createSession({
        workspacePath: workspacePath.trim(),
        defaultModel: modelRef,
        permissionProfile,
      });
      setSessions(await listSessions());
      setWorkspacePath("");
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

  function showNewSession() {
    sessionViewGeneration.current += 1;
    streamController.current?.abort();
    const previousSessionId = activeSessionId.current;
    if (previousSessionId !== null) requestControllers.current.get(previousSessionId)?.abort();
    activeSessionId.current = null;
    setActiveSession(null);
    setItems([]);
    setDraft("");
    setLiveAnswer("");
    setActiveTurnId(null);
    setConfirmingRequest(false);
    setSettlingRequest(false);
    setSessionLoading(false);
    setSending(false);
    setError(null);
  }

  return (
    <div className={`agent-shell ${isDesktop ? "is-desktop" : "is-web"}`}>
      {isDesktop ? (
        <div className="window-bar">
          <div className="window-brand"><BrandMark /><strong>AI-ME</strong><span>alpha</span></div>
          <div className="window-drag-title">本地 Agent 工作台</div>
        </div>
      ) : null}

      <aside className="session-sidebar">
        <div className="sidebar-head">
          {!isDesktop ? <div className="web-brand"><BrandMark /><strong>AI-ME</strong></div> : null}
          <button className="new-session-button" type="button" onClick={showNewSession}>
            <Plus size={16} /> 新对话
          </button>
        </div>

        <div className="session-section-label"><span>会话</span><PanelLeft size={14} /></div>
        <nav className="session-list" aria-label="Agent 会话">
          {loading ? <p className="sidebar-hint">正在恢复本地会话…</p> : null}
          {!loading && sessions.length === 0 ? <p className="sidebar-hint">还没有会话，从新对话开始。</p> : null}
          {sessions.map((session) => (
            <button
              className={`session-row${activeSession?.id === session.id ? " is-active" : ""}`}
              key={session.id}
              type="button"
              onClick={() => void openSession(session)}
            >
              <span className="session-icon"><MessageSquare size={14} /></span>
              <span className="session-copy"><strong>{session.title}</strong><small>{shortWorkspace(session.workspacePath)}</small></span>
              {session.activity !== "idle" ? <span className="running-dot" /> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="runtime-state">
            <span className="runtime-orb"><Bot size={15} /></span>
            <span><strong>本地 Runtime</strong><small>数据保存在这台电脑</small></span>
            <span className="online-dot" />
          </div>
          <button className="settings-row" type="button"><Settings size={15} /> 设置</button>
        </div>
      </aside>

      <main className="conversation-workspace">
        {activeSession ? (
          <>
            <header className="conversation-header">
              <div><h1>{activeSession.title}</h1><p><Folder size={13} /> {activeSession.workspacePath}</p></div>
              <div className="session-facts">
                <span>{activeSession.defaultModel}</span>
                <span><ShieldCheck size={13} /> {permissionLabels[activeSession.permissionProfile]}</span>
                <button type="button" aria-label="会话菜单"><ChevronDown size={15} /></button>
              </div>
            </header>

            <section className="timeline" aria-live="polite">
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
                      ? toolInvocations
                          .filter((invocation) => invocation.turnId === item.turnId)
                          .map((invocation) => (
                            <ToolActivityCard key={invocation.id} invocation={invocation} />
                          ))
                      : null}
                  </Fragment>
                ))}
                {approvals.length === 0 &&
                (liveAnswer || (sending && !confirmingRequest && !settlingRequest)) ? (
                  <LiveMessage text={liveAnswer} />
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

            <footer className="composer-zone">
              {error ? <div className="inline-error"><CircleAlert size={14} />{error}</div> : null}
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
            onWorkspaceChange={setWorkspacePath}
            onChooseWorkspace={() => void chooseWorkspace()}
            onModelChange={setModelRef}
            onPermissionChange={setPermissionProfile}
            onSubmit={() => void submitSession()}
          />
        )}
      </main>
    </div>
  );
}

function MessageItem({ item }: { item: SessionItem }) {
  const role = item.type === "user_message" ? "user" : item.type === "error" ? "error" : "agent";
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{role === "user" ? "你" : <Bot size={16} />}</div>
      <div className="message-body">
        <span className="message-author">{role === "user" ? "你" : role === "error" ? "运行中断" : "AI-ME"}</span>
        <p>{itemText(item)}</p>
      </div>
    </article>
  );
}

function LiveMessage({ text }: { text: string }) {
  return (
    <article className="message agent live">
      <div className="message-avatar"><Bot size={16} /></div>
      <div className="message-body">
        <span className="message-author">AI-ME <i>正在生成</i></span>
        {text ? <p>{text}</p> : <div className="typing"><span /><span /><span /></div>}
      </div>
    </article>
  );
}

const toolStatusLabels: Record<ToolInvocation["status"], string> = {
  prepared: "已准备",
  waiting_for_approval: "等待确认",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  uncertain: "结果不确定",
};

function ToolActivityCard({ invocation }: { invocation: ToolInvocation }) {
  const argumentHint =
    typeof invocation.arguments.path === "string"
      ? invocation.arguments.path
      : typeof invocation.arguments.command === "string"
        ? invocation.arguments.command
        : JSON.stringify(invocation.arguments);
  return (
    <div className={`tool-activity ${invocation.isError ? "failed" : ""}`}>
      <span className="tool-activity-dot" />
      <div>
        <strong>{invocation.toolName}</strong>
        <small>{argumentHint}</small>
      </div>
      <span>{toolStatusLabels[invocation.status]}</span>
    </div>
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
  onWorkspaceChange: (value: string) => void;
  onChooseWorkspace: () => void;
  onModelChange: (value: string) => void;
  onPermissionChange: (value: PermissionProfile) => void;
  onSubmit: () => void;
}

function NewSessionPanel(props: NewSessionPanelProps) {
  const canCreate = Boolean(props.workspacePath.trim() && props.modelRef && !props.creating);
  return (
    <section className="new-session-view">
      <div className="new-session-card">
        <span className="new-session-mark"><Bot size={25} /></span>
        <div className="new-session-heading">
          <span>LOCAL AGENT SESSION</span>
          <h1>开始一段新的工作会话</h1>
          <p>会话会固定绑定一个本地工作区，消息、运行事件与恢复状态都保存在本机。</p>
        </div>

        <div className="session-form">
          <label>
            <span>工作区</span>
            <div className="workspace-field">
              <FolderOpen size={16} />
              <input
                value={props.workspacePath}
                onChange={(event) => props.onWorkspaceChange(event.target.value)}
                placeholder="选择或输入一个已存在的目录"
              />
              {props.isDesktop ? <button type="button" onClick={props.onChooseWorkspace}>选择</button> : null}
            </div>
          </label>

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

        {props.models.length === 0 ? <p className="model-guidance">请先在后端环境中配置一个 AIME_*_API_KEY，然后重新启动应用。</p> : null}
        {props.error ? <div className="inline-error"><CircleAlert size={14} />{props.error}</div> : null}
        <button className="create-session-button" type="button" disabled={!canCreate} onClick={props.onSubmit}>
          {props.creating ? "正在创建…" : "创建会话"}<Send size={15} />
        </button>
      </div>
    </section>
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
