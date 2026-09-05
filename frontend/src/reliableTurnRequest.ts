/** 处理 Turn 创建响应不确定时的幂等对账与重试。 */

import {
  ApiError,
  type AgentTurn,
  getTurnByClientRequest,
  startTurn,
} from "./api";

export interface ReliableTurnDependencies {
  start: typeof startTurn;
  lookup: typeof getTurnByClientRequest;
  wait: typeof reconnectDelay;
}

export class TurnRequestUncertainError extends Error {}

export class TurnReconciliationTimeoutError extends Error {
  constructor() {
    super("对账请求超时；原请求标识已保留，可再次安全确认");
    this.name = "TurnReconciliationTimeoutError";
  }
}

export const TURN_RECONCILIATION_TIMEOUT_MS = 5_000;

export async function lookupTurnWithTimeout(
  sessionId: string,
  clientRequestId: string,
  timeoutMs = TURN_RECONCILIATION_TIMEOUT_MS,
  lookup: typeof getTurnByClientRequest = getTurnByClientRequest,
): Promise<AgentTurn | null> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = globalThis.setTimeout(() => {
      controller.abort();
      reject(new TurnReconciliationTimeoutError());
    }, timeoutMs);
  });
  try {
    // Promise.race 同时防护没有正确响应 AbortSignal 的异常客户端实现。
    return await Promise.race([
      lookup(sessionId, clientRequestId, controller.signal),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
  }
}

export function createReliableTurnStarter(dependencies: ReliableTurnDependencies) {
  return async function reliableStart(
    sessionId: string,
    input: string,
    clientRequestId: string,
    signal: AbortSignal,
    onRetry: (attempt: number) => void,
  ): Promise<AgentTurn> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        return await dependencies.start(sessionId, input, clientRequestId, signal);
      } catch (reason) {
        if (signal.aborted) break;
        if (isDefinitiveStartFailure(reason)) throw reason;
        attempt += 1;
        onRetry(attempt);

        try {
          const accepted = await dependencies.lookup(sessionId, clientRequestId, signal);
          if (accepted !== null) return accepted;
        } catch (lookupReason) {
          if (signal.aborted) break;
          if (isDefinitiveStartFailure(lookupReason)) throw lookupReason;
        }
        if (attempt >= 5) {
          throw new TurnRequestUncertainError(
            "发送结果仍未确认；再次发送会沿用原请求标识继续对账，不会重复执行",
          );
        }
        await dependencies.wait(signal, attempt);
      }
    }
    throw new Error("发送确认已取消");
  };
}

export function reconnectDelay(signal: AbortSignal, attempt: number): Promise<void> {
  // 指数退避减少断线时的本地请求压力，切换会话仍可立即取消等待。
  const milliseconds = Math.min(250 * 2 ** Math.min(attempt - 1, 3), 2_000);
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isDefinitiveStartFailure(reason: unknown) {
  return (
    reason instanceof ApiError &&
    reason.status >= 400 &&
    reason.status < 500 &&
    ![408, 425, 429].includes(reason.status)
  );
}

export const startTurnReliably = createReliableTurnStarter({
  start: startTurn,
  lookup: getTurnByClientRequest,
  wait: reconnectDelay,
});
