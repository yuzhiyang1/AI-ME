import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type AgentTurn } from "./api";
import {
  TurnReconciliationTimeoutError,
  createReliableTurnStarter,
  lookupTurnWithTimeout,
} from "./reliableTurnRequest";

const acceptedTurn: AgentTurn = {
  id: "turn-1",
  sessionId: "session-1",
  status: "queued",
  createdAt: "2026-09-05T00:00:00Z",
  startedAt: null,
  finishedAt: null,
};

describe("可靠 Turn 创建", () => {
  afterEach(() => vi.useRealTimers());

  it("POST 结果不确定时按同一幂等键查询已接受事实", async () => {
    const startKeys: string[] = [];
    const lookupKeys: string[] = [];
    const starter = createReliableTurnStarter({
      start: async (_sessionId, _input, clientRequestId) => {
        startKeys.push(clientRequestId);
        throw new TypeError("network disconnected");
      },
      lookup: async (_sessionId, clientRequestId) => {
        lookupKeys.push(clientRequestId);
        return acceptedTurn;
      },
      wait: async () => undefined,
    });

    const result = await starter(
      "session-1",
      "执行任务",
      "stable-request-id",
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(acceptedTurn);
    expect(startKeys).toEqual(["stable-request-id"]);
    expect(lookupKeys).toEqual(["stable-request-id"]);
  });

  it("服务恢复前持续复用同一幂等键重试", async () => {
    const startKeys: string[] = [];
    let startCount = 0;
    const starter = createReliableTurnStarter({
      start: async (_sessionId, _input, clientRequestId) => {
        startKeys.push(clientRequestId);
        startCount += 1;
        if (startCount === 1) throw new TypeError("network disconnected");
        return acceptedTurn;
      },
      lookup: async () => null,
      wait: async () => undefined,
    });

    const result = await starter(
      "session-1",
      "执行任务",
      "stable-request-id",
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(acceptedTurn);
    expect(startKeys).toEqual(["stable-request-id", "stable-request-id"]);
  });

  it("确定的 409 响应不会进入网络重试", async () => {
    let lookupCount = 0;
    const starter = createReliableTurnStarter({
      start: async () => {
        throw new ApiError("冲突", 409);
      },
      lookup: async () => {
        lookupCount += 1;
        return null;
      },
      wait: async () => undefined,
    });

    await expect(
      starter(
        "session-1",
        "执行任务",
        "stable-request-id",
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow("冲突");
    expect(lookupCount).toBe(0);
  });

  it("持续故障达到上限后停止自动重试并保留不确定语义", async () => {
    let startCount = 0;
    let waitCount = 0;
    const starter = createReliableTurnStarter({
      start: async () => {
        startCount += 1;
        throw new TypeError("network disconnected");
      },
      lookup: async () => null,
      wait: async () => {
        waitCount += 1;
      },
    });

    await expect(
      starter(
        "session-1",
        "执行任务",
        "stable-request-id",
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow("再次发送会沿用原请求标识");
    expect(startCount).toBe(5);
    expect(waitCount).toBe(4);
  });

  it("最终对账永不返回时按时中断并退出等待", async () => {
    vi.useFakeTimers();
    let lookupSignal: AbortSignal | undefined;
    const lookup = vi.fn(
      async (_sessionId: string, _clientRequestId: string, signal?: AbortSignal) => {
        lookupSignal = signal;
        return await new Promise<AgentTurn | null>(() => undefined);
      },
    );

    const result = lookupTurnWithTimeout("session-1", "stable-request-id", 1_000, lookup)
      .catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await result).toBeInstanceOf(TurnReconciliationTimeoutError);
    expect(lookupSignal?.aborted).toBe(true);
  });
});
