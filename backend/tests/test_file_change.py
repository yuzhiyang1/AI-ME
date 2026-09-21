"""验证本次工具执行差异，而不是 Git 基线或事后读取的文件内容。"""

from pathlib import Path

import pytest

from aime.application.ports.tool_execution import ToolExecutionContext, ToolExecutionResult
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.tools import builtin
from aime.infrastructure.tools.builtin import EditFileTool, ToolInputError, WriteFileTool
from aime.infrastructure.tools.file_change import MAX_DIFF_BYTES, build_file_change


def context(path: Path) -> ToolExecutionContext:
    return ToolExecutionContext("session", "turn", "run", str(path), PermissionProfile.FULL_ACCESS)


@pytest.mark.parametrize("before", [None, "用户已有内容\n", "", "旧值"])
async def test_write_captures_actual_before_and_after(tmp_path: Path, before: str | None) -> None:
    target = tmp_path / "中文.txt"
    if before is not None:
        target.write_bytes(before.encode("utf-8"))
    result = await WriteFileTool().execute(
        {"path": "中文.txt", "content": "新值\n", "overwrite": True}, context(tmp_path)
    )
    change = result.output["file_change"]
    assert isinstance(change, dict)
    assert change["operation"] == ("create" if before is None else "modify")
    assert change["status"] == "available"
    assert change["additions"] == 1
    assert change["deletions"] == (1 if before else 0)
    assert target.read_bytes() == "新值\n".encode()
    assert "file_change" not in result.model_output

    # 后续手工修改不能改变已经生成的历史事实。
    target.write_text("后续变化", encoding="utf-8")
    assert "后续变化" not in str(change)
    assert "+新值" in str(change)


async def test_edit_preserves_crlf_and_records_all_replacements(tmp_path: Path) -> None:
    target = tmp_path / "demo.txt"
    target.write_bytes(b"user-local\r\nold\r\nold\r\n")
    result = await EditFileTool().execute(
        {"path": "demo.txt", "old_text": "old", "new_text": "new", "replace_all": True},
        context(tmp_path),
    )
    change = result.output["file_change"]
    assert isinstance(change, dict)
    assert change["additions"] == change["deletions"] == 2
    assert target.read_bytes() == b"user-local\r\nnew\r\nnew\r\n"
    assert "-user-local" not in str(change)


async def test_clear_file_and_missing_final_newline(tmp_path: Path) -> None:
    target = tmp_path / "demo.txt"
    target.write_bytes(b"old")
    result = await EditFileTool().execute(
        {"path": "demo.txt", "old_text": "old", "new_text": ""}, context(tmp_path)
    )
    change = result.output["file_change"]
    assert isinstance(change, dict)
    assert change["additions"] == 0
    assert change["deletions"] == 1
    assert change["hunks"][0]["lines"] == ["-old", "\\ No newline at end of file"]
    assert target.read_bytes() == b""


@pytest.mark.parametrize(
    "before", [b"\xff\x00", b"a" * (MAX_DIFF_BYTES + 1)], ids=["binary", "oversize"]
)
async def test_unpreviewable_overwrite_still_writes_without_fake_diff(
    tmp_path: Path, before: bytes
) -> None:
    target = tmp_path / "demo.txt"
    target.write_bytes(before)
    result = await WriteFileTool().execute(
        {"path": "demo.txt", "content": "new", "overwrite": True}, context(tmp_path)
    )
    change = result.output["file_change"]
    assert isinstance(change, dict)
    assert change["status"] == "unavailable"
    assert "hunks" not in change
    assert target.read_bytes() == b"new"


async def test_failed_write_does_not_publish_change(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.txt"
    target.write_text("old", encoding="utf-8")

    def fail_write(*args) -> None:
        raise OSError("模拟磁盘错误")

    monkeypatch.setattr(builtin, "_atomic_write", fail_write)
    with pytest.raises(OSError, match="模拟磁盘错误"):
        await WriteFileTool().execute(
            {"path": "demo.txt", "content": "new", "overwrite": True}, context(tmp_path)
        )
    assert target.read_text() == "old"


async def test_ambiguous_edit_keeps_file_unchanged(tmp_path: Path) -> None:
    target = tmp_path / "demo.txt"
    target.write_text("old old", encoding="utf-8")
    with pytest.raises(ToolInputError, match="出现多次"):
        await EditFileTool().execute(
            {"path": "demo.txt", "old_text": "old", "new_text": "new"}, context(tmp_path)
        )
    assert target.read_text() == "old old"


def test_unchanged_large_and_no_newline_boundary() -> None:
    assert build_file_change("a", "same", "same")["status"] == "unchanged"
    assert build_file_change("a", "a\n" * 4001, "b")["status"] == "unavailable"
    change = build_file_change("a", "line", "line\n")
    assert change["additions"] == change["deletions"] == 1
    assert change["hunks"][0]["lines"] == ["-line", "\\ No newline at end of file", "+line"]


def test_restored_ledger_result_keeps_display_out_of_model_context() -> None:
    result = ToolExecutionResult({"path": "a", "file_change": {"hunks": ["private preview"]}})
    assert result.model_output == {"path": "a"}
    assert "file_change" in result.output
