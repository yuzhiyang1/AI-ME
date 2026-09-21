"""生成本次文件写入的有界差异事实，不依赖 Git，也不在查看历史时重读文件。"""

from difflib import SequenceMatcher
from pathlib import Path

MAX_DIFF_BYTES = 200_000
MAX_DIFF_LINES = 4_000


def read_before_write(path: Path) -> tuple[str | None, str | None]:
    """覆盖旧文件时保留原始换行；二进制或大文件只记录无法预览的原因。"""
    if not path.exists():
        return "", None
    with path.open("rb") as handle:
        data = handle.read(MAX_DIFF_BYTES + 1)
    if len(data) > MAX_DIFF_BYTES:
        return None, "文件过大，未保存差异预览"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None, "原文件不是 UTF-8 文本，无法提供文本差异"
    if "\x00" in text:
        return None, "原文件包含二进制内容，无法提供文本差异"
    return text, None


def build_file_change(
    path: str,
    before: str | None,
    after: str,
    *,
    created: bool = False,
    unavailable_reason: str | None = None,
) -> dict[str, object]:
    """先生成候选差异；调用者只在文件成功写入后提交到工具结果账本。"""
    change: dict[str, object] = {
        "version": 1,
        "path": path,
        "operation": "create" if created else "modify",
    }
    if before is None:
        return {**change, "status": "unavailable", "reason": unavailable_reason}
    if before == after:
        return {**change, "status": "unchanged", "reason": "文件内容未变化"}
    if "\x00" in before or "\x00" in after:
        return {**change, "status": "unavailable", "reason": "二进制内容不支持文本差异"}

    # 同时限制字符负载和行数，避免大量重复行使比较和前端渲染失控。
    if max(len(before.encode("utf-8")), len(after.encode("utf-8"))) > MAX_DIFF_BYTES:
        return {**change, "status": "unavailable", "reason": "文件过大，未保存差异预览"}
    old_lines, new_lines = before.splitlines(keepends=True), after.splitlines(keepends=True)
    if max(len(old_lines), len(new_lines)) > MAX_DIFF_LINES:
        return {**change, "status": "unavailable", "reason": "文件行数过多，未保存差异预览"}

    # 每个 hunk 保留三行上下文；没有末尾换行时显式标记，不能把它当成空行。
    hunks: list[dict[str, object]] = []
    additions = deletions = 0
    matcher = SequenceMatcher(None, old_lines, new_lines, autojunk=True)
    for group in matcher.get_grouped_opcodes(3):
        old_start, old_end = group[0][1], group[-1][2]
        new_start, new_end = group[0][3], group[-1][4]
        lines: list[str] = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                _append_lines(lines, " ", old_lines[i1:i2])
            if tag in {"delete", "replace"}:
                deletions += i2 - i1
                _append_lines(lines, "-", old_lines[i1:i2])
            if tag in {"insert", "replace"}:
                additions += j2 - j1
                _append_lines(lines, "+", new_lines[j1:j2])
        hunks.append(
            {
                "old_start": old_start + (1 if old_end > old_start else 0),
                "old_lines": old_end - old_start,
                "new_start": new_start + (1 if new_end > new_start else 0),
                "new_lines": new_end - new_start,
                "lines": lines,
            }
        )
    return {
        **change,
        "status": "available",
        "additions": additions,
        "deletions": deletions,
        "hunks": hunks,
    }


def _append_lines(target: list[str], prefix: str, lines: list[str]) -> None:
    for line in lines:
        target.append(prefix + line.removesuffix("\n").removesuffix("\r"))
        if not line.endswith("\n"):
            target.append("\\ No newline at end of file")
