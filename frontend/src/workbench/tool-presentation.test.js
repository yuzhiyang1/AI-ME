import { describe, expect, it } from "vitest";
import { projectConversation } from "./protocol.js";
import { projectToolPresentation } from "./tool-presentation.js";
import { toolCallRowToLegacyNode } from "../../vendor/zcode/packages/ui/src/v4/toolCallRowAdapter.ts";
import { readRawToolCallFileSummaries } from "../../vendor/zcode/packages/ui/src/ToolCallBlocks/fileSummaries.ts";
import { buildEditCodeViewerSource } from "../../vendor/zcode/packages/ui/src/ToolCallBlocks/renderers/edit.tsx";

const tool = {
  id: "tool-1",
  callId: "call-1",
  turnId: "turn-1",
  toolName: "edit_file",
  status: "completed",
  isError: false,
  arguments: { path: "demo.txt", old_text: "old", new_text: "new" },
  preparedAt: "2026-09-21T00:00:00Z",
  result: {
    path: "demo.txt",
    replacements: 1,
    file_change: {
      version: 1,
      path: "demo.txt",
      operation: "modify",
      status: "available",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          lines: ["-old", "+new"],
        },
      ],
    },
  },
};

describe("本次文件差异接入原版卡片和预览", () => {
  it("通过真实协议 schema、原版行适配和文件摘要后仍可打开 patch", () => {
    const snapshot = projectConversation({
      session: {
        id: "s",
        title: "测试",
        defaultModel: "p/m",
        activity: "idle",
      },
      items: [],
      tools: [tool],
      approvals: [],
      usage: {},
      activeTurn: null,
      rowIds: new Map(),
      commandByTurn: new Map(),
      epoch: "e",
      seq: 1,
    });
    const row = snapshot.rows.window.find((entry) => entry.kind === "toolCall");
    const { toolCall } = toolCallRowToLegacyNode(row);
    const summaries = readRawToolCallFileSummaries(toolCall.raw, toolCall);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].changeStat).toEqual({ added: 1, removed: 1 });
    const preview = buildEditCodeViewerSource(summaries[0]);
    expect(preview.type).toBe("patch");
    expect(preview.patch).toContain("-old\n+new");
    expect(row.toolCallId).toBe("call-1");
    expect(row.output.text).not.toContain("hunks");
  });

  it.each(["write_file", "edit_file"])(
    "%s 的权威差异进入 Edit 展示",
    (toolName) => {
      expect(
        projectToolPresentation({ ...tool, toolName }).output.display.kind,
      ).toBe("file_diff");
    },
  );

  it.each([
    "failed",
    "rejected",
    "uncertain",
    "running",
    "waiting_for_approval",
  ])("%s 不把输入或残留结果当成成功修改", (status) => {
    const result = projectToolPresentation({ ...tool, status });
    expect(result.toolName).toBeUndefined();
    expect(result.output.display).toBeUndefined();
    expect(result.output.text).toContain("未确认成功");
  });

  it("旧记录不能拿 old_text/new_text 或当前文件冒充已保存的历史差异", () => {
    const result = projectToolPresentation({
      ...tool,
      result: { path: "demo.txt" },
    });
    expect(result.output.display).toBeUndefined();
    expect(result.output.text).toContain("历史记录未保存");
  });

  it.each(["unavailable", "unchanged"])(
    "%s 显示原因而不是伪造 patch",
    (status) => {
      const result = projectToolPresentation({
        ...tool,
        result: { file_change: { status, reason: "明确原因" } },
      });
      expect(result.output.display).toBeUndefined();
      expect(result.output.text).toContain("明确原因");
    },
  );
});
