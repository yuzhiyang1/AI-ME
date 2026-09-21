/** 只将成功落账的文件差异映射为原版 Edit 卡片，不能拿工具输入冒充已执行的变更。 */
export function projectToolPresentation(tool) {
  const isFileWrite = ["write_file", "edit_file"].includes(tool.toolName);
  if (!isFileWrite || !tool.result) return {};

  const { file_change: change, ...result } = tool.result;
  const confirmed = tool.status === "completed" && !tool.isError;
  if (confirmed && change?.version === 1 && change.status === "available") {
    return {
      toolName: "Edit",
      output: {
        text: JSON.stringify(result),
        display: {
          kind: "file_diff",
          filePath: change.path,
          additions: change.additions,
          deletions: change.deletions,
          structuredPatch: change.hunks.map((hunk) => ({
            oldStart: hunk.old_start,
            oldLines: hunk.old_lines,
            newStart: hunk.new_start,
            newLines: hunk.new_lines,
            lines: hunk.lines,
          })),
        },
      },
    };
  }

  // 旧记录、大文件及失败调用仍显示原始工具结果，不重新读取当前文件拼凑历史。
  const reason = confirmed
    ? change?.reason || "此历史记录未保存修改前后差异"
    : "本次修改未确认成功，不提供已完成差异";
  return {
    output: { text: JSON.stringify({ ...result, diffPreview: reason }) },
  };
}
