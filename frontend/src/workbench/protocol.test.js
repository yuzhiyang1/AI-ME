import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectConversation,
  createProtocol,
  parseTimestamp,
} from "./protocol.js";
import { modelView, taskMeta } from "./services.js";
import { validateModelSelectionOptions } from "../../vendor/zcode/packages/provider/src/registry.ts";
import { conversationTopicWireFrameSchema } from "../../vendor/zcode/packages/shared/src/zcode-protocol-v4/transport.ts";
import { serviceBoundary } from "./events.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Ansi from "ansi-to-react";

const session = {
  id: "s1",
  title: "联调",
  workspacePath: "D:\\test",
  defaultModel: "test/model",
  activity: "idle",
  lifecycle: "active",
  pinned: false,
  createdAt: "2026-09-21T02:00:00",
  updatedAt: "2026-09-21T02:00:01",
};
const models = [
  {
    ref: "test/model",
    provider: "test",
    modelId: "model",
    displayName: "测试模型",
    contextWindow: 128000,
  },
];
const item = {
  id: "i1",
  turnId: "t1",
  createdAt: session.createdAt,
  type: "user_message",
  status: "completed",
  content: { text: "你好" },
};
const fixture = (overrides) => ({
  session,
  items: [item],
  tools: [],
  approvals: [],
  usage: {},
  activeTurn: null,
  rowIds: new Map(),
  commandByTurn: new Map([["t1", "cmd1"]]),
  epoch: "e1",
  seq: 1,
  ...overrides,
});
afterEach(() => vi.useRealTimers());

describe("AI-ME / ZCode 协议边界", () => {
  it("ANSI 查看器升级链接解析依赖后仍能渲染颜色与链接", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Ansi,
        { linkify: true },
        "\u001b[31m错误\u001b[0m https://example.com",
      ),
    );
    expect(html).toContain("错误");
    expect(html).toContain('href="https://example.com"');
  });
  it("无时区数据库时间按 UTC 解释", () => {
    expect(parseTimestamp(session.createdAt)).toBe(
      Date.parse("2026-09-21T02:00:00Z"),
    );
    expect(parseTimestamp("2026-09-21T10:00:00+08:00")).toBe(
      parseTimestamp(session.createdAt),
    );
  });
  it("模型目录满足原版发送门禁且不含密钥", () => {
    const view = modelView(models);
    expect(
      validateModelSelectionOptions(
        view.providers[0].models[0],
        view.effectiveSelection,
      ).ok,
    ).toBe(true);
    expect(JSON.stringify(view)).not.toContain('"apiKey"');
    expect(modelView([]).selectionIssue).toBe("selection-missing");
  });
  it("用户行带原 commandId，更新后行 ID 不变", () => {
    const data = fixture({});
    const first = projectConversation(data);
    const second = projectConversation({
      ...data,
      seq: 2,
      items: [{ ...item, content: { text: "更新" } }],
    });
    expect(first.rows.window[1].sourceCommandId).toBe("cmd1");
    expect(second.rows.window[1].rowId).toBe(first.rows.window[1].rowId);
    expect(second.rows.window[1].text).toBe("更新");
  });
  it("失败不伪装为完成成功", () => {
    const snapshot = projectConversation(
      fixture({
        items: [
          item,
          {
            ...item,
            id: "error",
            type: "error",
            status: "failed",
            content: { message: "模型超时" },
          },
        ],
      }),
    );
    expect(snapshot.control.phase).toBe("error");
    expect(snapshot.control.lastError.message).toBe("模型超时");
    expect(snapshot.rows.window[0].state).toBe("failed");
  });
  it("审批保持原 invocation 关联，未接入的行为明确禁用", () => {
    const snapshot = projectConversation(
      fixture({
        session: { ...session, activity: "waiting_for_user" },
        activeTurn: { id: "t1", createdAt: session.createdAt },
        tools: [
          {
            id: "tool1",
            turnId: "t1",
            callId: "call1",
            toolName: "write_file",
            arguments: { path: "a.txt" },
            status: "waiting_for_approval",
            preparedAt: session.updatedAt,
          },
        ],
        approvals: [
          {
            id: "approval1",
            invocationId: "tool1",
            toolName: "write_file",
            reason: "写文件",
            arguments: {},
            requestedAt: session.updatedAt,
          },
        ],
      }),
    );
    expect(snapshot.pendingInteractions[0].payload.toolCallId).toBe("call1");
    expect(snapshot.pendingInteractions[0].anchorRowId).toBe(
      snapshot.rows.window[2].rowId,
    );
    expect(snapshot.availability.fork.allowed).toBe(false);
    expect(snapshot.control.canStop).toBe(true);
  });
  it("缺少服务实现时拒绝，不能返回假成功", async () => {
    await expect(serviceBoundary("gitService").commit()).rejects.toThrow(
      "尚未接入",
    );
  });
  it("预热不持久化；同一创建命令只执行一次", async () => {
    const api = {
      createSession: vi.fn().mockResolvedValue(session),
      startTurn: vi.fn().mockResolvedValue({ id: "t1" }),
    };
    const { agent } = createProtocol(api, models, taskMeta);
    const params = {
      workspacePath: session.workspacePath,
      envelope: {
        commandId: "c1",
        clientId: "client",
        sessionId: null,
        type: "createSession",
        payload: {},
      },
    };
    expect((await agent.sendConversationCommandV4(params)).status).toBe(
      "rejected",
    );
    expect(api.createSession).not.toHaveBeenCalled();
    params.envelope = {
      ...params.envelope,
      commandId: "c2",
      payload: { firstInput: { text: "你好" } },
    };
    await Promise.all([
      agent.sendConversationCommandV4(params),
      agent.sendConversationCommandV4(params),
    ]);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.startTurn).toHaveBeenCalledWith("s1", "你好", "c2");
  });
  it("附件不会被静默丢掉然后发纯文本", async () => {
    const api = { createSession: vi.fn() };
    const { agent } = createProtocol(api, models, taskMeta);
    const ack = await agent.sendConversationCommandV4({
      workspacePath: session.workspacePath,
      envelope: {
        commandId: "c3",
        clientId: "client",
        type: "createSession",
        payload: { firstInput: { text: "看附件", attachments: [{}] } },
      },
    });
    expect(ack.status).toBe("rejected");
    expect(api.createSession).not.toHaveBeenCalled();
  });
  it("initial 帧符合上游 schema，退订停止轮询", async () => {
    vi.useFakeTimers();
    const api = {
      getSession: vi.fn().mockResolvedValue(session),
      listSessionItems: vi.fn().mockResolvedValue([item]),
      listToolInvocations: vi.fn().mockResolvedValue([]),
      listPendingApprovals: vi.fn().mockResolvedValue([]),
      getSessionUsage: vi.fn().mockResolvedValue({}),
      getActiveTurn: vi.fn().mockResolvedValue(null),
    };
    const { agent } = createProtocol(api, models, taskMeta);
    const listener = vi.fn();
    const disposable = agent.onDynamicConversationFrame({})(listener);
    const { ack } = await agent.subscribeConversationV4({
      sessionId: "s1",
      workspacePath: session.workspacePath,
    });
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      conversationTopicWireFrameSchema.safeParse(listener.mock.calls[0][0])
        .success,
    ).toBe(true);
    await agent.unsubscribeConversationV4({
      subscriptionId: ack.subscriptionId,
    });
    disposable.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.getSession).toHaveBeenCalledTimes(1);
  });
});
