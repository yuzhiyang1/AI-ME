// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession, AgentTurn, SessionItem } from "./api";

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  decideApproval: vi.fn(),
  getActiveTurn: vi.fn(),
  getSession: vi.fn(),
  getTurnByClientRequest: vi.fn(),
  interruptTurn: vi.fn(),
  listModels: vi.fn(),
  listPendingApprovals: vi.fn(),
  listSessionItems: vi.fn(),
  listSessions: vi.fn(),
  listToolInvocations: vi.fn(),
  startTurn: vi.fn(),
  streamRuntimeEvents: vi.fn(),
}));

vi.mock("./api", () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return { ApiError, ...api };
});

import App from "./App";

const sessionA = session("session-a", "会话 A");
const sessionB = session("session-b", "会话 B");
const acceptedTurn: AgentTurn = {
  id: "turn-a",
  sessionId: sessionA.id,
  status: "queued",
  createdAt: "2026-09-05T00:00:00Z",
  startedAt: null,
  finishedAt: null,
};
const itemA = item("item-a", sessionA.id, "A 的消息");
const itemB = item("item-b", sessionB.id, "B 的消息");

describe("会话页面异步隔离", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    api.listSessions.mockResolvedValue([sessionA, sessionB]);
    api.listModels.mockResolvedValue([
      {
        ref: "qa/model",
        provider: "qa",
        modelId: "model",
        displayName: "QA Model",
        contextWindow: 32_000,
      },
    ]);
    api.getSession.mockImplementation(async (sessionId: string) =>
      sessionId === sessionA.id ? sessionA : sessionB,
    );
    api.getActiveTurn.mockResolvedValue(null);
    api.listPendingApprovals.mockResolvedValue([]);
    api.listToolInvocations.mockResolvedValue([]);
    api.getTurnByClientRequest.mockResolvedValue(null);
    api.startTurn.mockResolvedValue(acceptedTurn);
    api.streamRuntimeEvents.mockResolvedValue(undefined);
  });

  it("恢复会话后展示待审批工具，并允许用户仅批准本次", async () => {
    api.listSessionItems.mockResolvedValue([]);
    const approval = {
      id: "approval-a",
      sessionId: sessionA.id,
      turnId: acceptedTurn.id,
      runId: "run-a",
      invocationId: "invocation-a",
      toolName: "run_powershell",
      arguments: { command: "Get-ChildItem" },
      reason: "PowerShell 可以访问本地资源",
      status: "pending",
      decision: null,
      requestedAt: "2026-09-05T00:00:00Z",
      resolvedAt: null,
    };
    api.listPendingApprovals.mockResolvedValue([approval]);
    api.decideApproval.mockResolvedValue({
      ...approval,
      status: "approved",
      decision: "approve_once",
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("工具执行需要你的确认");
    expect(screen.getByText("run_powershell")).toBeTruthy();
    expect(screen.getByText(/Get-ChildItem/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "仅本次允许" }));

    await waitFor(() =>
      expect(api.decideApproval).toHaveBeenCalledWith(
        sessionA.id,
        approval.id,
        "approve_once",
      ),
    );
    await waitFor(() => expect(screen.queryByText("工具执行需要你的确认")).toBeNull());
  });

  it("重新打开会话时在对应用户消息后恢复工具审计记录", async () => {
    api.listSessionItems.mockResolvedValue([itemA]);
    api.listToolInvocations.mockResolvedValue([
      {
        id: "invocation-read",
        sessionId: sessionA.id,
        turnId: itemA.turnId,
        runId: "run-read",
        callId: "call-read",
        stepIndex: 1,
        callIndex: 0,
        toolName: "read_file",
        arguments: { path: "README.md" },
        assistantText: "",
        executionSemantics: "parallel",
        riskLevel: "read",
        status: "completed",
        result: { content: "ok" },
        isError: false,
        preparedAt: "2026-09-05T00:00:00Z",
        startedAt: "2026-09-05T00:00:01Z",
        finishedAt: "2026-09-05T00:00:02Z",
      },
    ]);

    render(<App />);

    await screen.findByText("read_file");
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
  });

  it("切到 B 后忽略 A 延迟返回的 Items，也不会启动 A 的事件流", async () => {
    let resolveDelayedItems!: (items: SessionItem[]) => void;
    const delayedItems = new Promise<SessionItem[]>((resolve) => {
      resolveDelayedItems = resolve;
    });
    let sessionAItemRequests = 0;
    api.listSessionItems.mockImplementation(async (sessionId: string) => {
      if (sessionId === sessionB.id) return [itemB];
      sessionAItemRequests += 1;
      return sessionAItemRequests === 1 ? [] : delayedItems;
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: sessionA.title });
    await user.type(screen.getByRole("textbox", { name: "给 AI-ME 发消息" }), "执行 A");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(sessionAItemRequests).toBe(2));

    await user.click(screen.getByRole("button", { name: /会话 B/ }));
    await screen.findByRole("heading", { name: sessionB.title });
    await act(async () => resolveDelayedItems([itemA]));

    expect(screen.getByText("B 的消息")).toBeTruthy();
    expect(screen.queryByText("A 的消息")).toBeNull();
    expect(api.streamRuntimeEvents).not.toHaveBeenCalledWith(
      sessionA.id,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("切换时立即清空旧投影，B 加载失败也不会泄漏 A 的消息", async () => {
    let rejectSessionB!: (reason: Error) => void;
    const delayedSessionB = new Promise<SessionItem[]>((_resolve, reject) => {
      rejectSessionB = reject;
    });
    api.listSessionItems.mockImplementation(async (sessionId: string) =>
      sessionId === sessionA.id ? [itemA] : delayedSessionB,
    );

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("A 的消息");

    await user.click(screen.getByRole("button", { name: /会话 B/ }));
    expect(screen.queryByText("A 的消息")).toBeNull();
    await act(async () => rejectSessionB(new Error("B 加载失败")));

    await screen.findByText("B 加载失败");
    expect(screen.queryByText("A 的消息")).toBeNull();
  });

  it("A→B→A 时忽略第一次 A 的迟到投影", async () => {
    const staleItem = item("stale-a", sessionA.id, "第一次 A 的旧投影");
    const latestItem = item("latest-a", sessionA.id, "第二次 A 的新投影");
    let resolveFirstA!: (items: SessionItem[]) => void;
    const firstAItems = new Promise<SessionItem[]>((resolve) => {
      resolveFirstA = resolve;
    });
    let sessionARequests = 0;
    api.listSessionItems.mockImplementation(async (sessionId: string) => {
      if (sessionId === sessionB.id) return [itemB];
      sessionARequests += 1;
      return sessionARequests === 1 ? firstAItems : [latestItem];
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: sessionA.title });

    await user.click(screen.getByRole("button", { name: /会话 B/ }));
    await screen.findByText("B 的消息");
    await user.click(screen.getByRole("button", { name: /会话 A/ }));
    await screen.findByText("第二次 A 的新投影");
    await act(async () => resolveFirstA([staleItem]));

    expect(screen.getByText("第二次 A 的新投影")).toBeTruthy();
    expect(screen.queryByText("第一次 A 的旧投影")).toBeNull();
  });

  it("取消请求确认时保持锁定，显式重试继续使用原幂等键", async () => {
    const requestKeys: string[] = [];
    let startCount = 0;
    api.listSessionItems.mockResolvedValue([]);
    api.startTurn.mockImplementation(
      async (
        _sessionId: string,
        _input: string,
        clientRequestId: string,
        signal?: AbortSignal,
      ) => {
        requestKeys.push(clientRequestId);
        startCount += 1;
        if (startCount > 1) return acceptedTurn;
        return await new Promise<AgentTurn>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    let resolveFinalLookup!: (turn: AgentTurn | null) => void;
    api.getTurnByClientRequest.mockImplementation(
      async () =>
        await new Promise<AgentTurn | null>((resolve) => {
          resolveFinalLookup = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: sessionA.title });
    const composer = screen.getByRole("textbox", { name: "给 AI-ME 发消息" });
    await user.type(composer, "需要安全确认的请求");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "停止确认" });

    await user.click(screen.getByRole("button", { name: "停止确认" }));
    const settlingButton = await screen.findByRole("button", { name: "正在对账" });
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);
    expect((settlingButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveFinalLookup(null));

    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
    expect((composer as HTMLTextAreaElement).value).toBe("需要安全确认的请求");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(requestKeys).toHaveLength(2));
    expect(requestKeys[1]).toBe(requestKeys[0]);
  });

  it("停止确认后切走再返回，由原对账流程统一解锁当前会话", async () => {
    let requestAccepted = false;
    api.listSessionItems.mockImplementation(async (sessionId: string) => {
      if (sessionId === sessionB.id) return [itemB];
      return requestAccepted ? [itemA] : [];
    });
    api.startTurn.mockImplementation(
      async (
        _sessionId: string,
        _input: string,
        _clientRequestId: string,
        signal?: AbortSignal,
      ) =>
        await new Promise<AgentTurn>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    let resolveFinalLookup!: (turn: AgentTurn | null) => void;
    api.getTurnByClientRequest.mockImplementation(
      async () =>
        await new Promise<AgentTurn | null>((resolve) => {
          resolveFinalLookup = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: sessionA.title });
    const composer = screen.getByRole("textbox", { name: "给 AI-ME 发消息" });
    await user.type(composer, "切换期间仍要安全对账");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "停止确认" }));
    await screen.findByRole("button", { name: "正在对账" });

    await user.click(screen.getByRole("button", { name: /会话 B/ }));
    await screen.findByText("B 的消息");
    await user.click(screen.getByRole("button", { name: /会话 A/ }));
    await screen.findByRole("button", { name: "正在对账" });
    expect(api.getTurnByClientRequest).toHaveBeenCalledTimes(1);

    requestAccepted = true;
    await act(async () => resolveFinalLookup(acceptedTurn));

    await screen.findByText("A 的消息");
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "正在对账" })).toBeNull();
    expect(api.getTurnByClientRequest).toHaveBeenCalledTimes(1);
  });
});

function session(id: string, title: string): AgentSession {
  return {
    id,
    title,
    workspacePath: `D:\\workspace\\${id}`,
    defaultModel: "qa/model",
    permissionProfile: "workspace_write",
    lifecycle: "active",
    activity: "idle",
    pinned: false,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
  };
}

function item(id: string, sessionId: string, text: string): SessionItem {
  return {
    id,
    sessionId,
    turnId: `turn-${id}`,
    runId: `run-${id}`,
    sequence: 1,
    type: "user_message",
    status: "completed",
    content: { text },
    createdAt: "2026-09-05T00:00:00Z",
  };
}
