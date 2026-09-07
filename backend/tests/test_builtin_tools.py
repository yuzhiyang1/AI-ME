"""验证内置工具的工作区边界、权限和确定性编辑语义。"""

from pathlib import Path
from uuid import uuid4

import pytest

from aime.application.ports.tool_execution import ToolExecutionContext
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.tools.builtin import BuiltInToolRegistry, ToolInputError


def _context(workspace: Path, permission: PermissionProfile) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id=str(uuid4()),
        turn_id=str(uuid4()),
        run_id=str(uuid4()),
        workspace_path=str(workspace),
        permission_profile=permission,
    )


def test_read_only_session_only_exposes_read_tools() -> None:
    """模型看不到当前权限不可能执行的写入和命令工具。"""
    registry = BuiltInToolRegistry()

    read_only = {
        descriptor.definition.name
        for descriptor in registry.descriptors(PermissionProfile.READ_ONLY)
    }
    writable = {
        descriptor.definition.name
        for descriptor in registry.descriptors(PermissionProfile.WORKSPACE_WRITE)
    }

    assert read_only == {"list_files", "search_text", "read_file"}
    assert writable == read_only | {"write_file", "edit_file", "run_powershell"}


async def test_file_tools_reject_parent_and_absolute_path_escape(tmp_path: Path) -> None:
    """即使目标真实存在，文件工具也不能跨出 Session 工作区。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")
    tool = BuiltInToolRegistry().get("read_file")
    assert tool is not None
    context = _context(workspace, PermissionProfile.READ_ONLY)

    with pytest.raises(ToolInputError, match="不能离开"):
        await tool.execute({"path": "../secret.txt"}, context)
    with pytest.raises(ToolInputError, match="相对工作区"):
        await tool.execute({"path": str(outside)}, context)


async def test_write_and_edit_tools_require_explicit_unambiguous_intent(tmp_path: Path) -> None:
    """覆盖必须显式声明，精确编辑默认拒绝多处匹配。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    registry = BuiltInToolRegistry()
    write_tool = registry.get("write_file")
    edit_tool = registry.get("edit_file")
    assert write_tool is not None and edit_tool is not None
    context = _context(workspace, PermissionProfile.WORKSPACE_WRITE)

    created = await write_tool.execute({"path": "notes.txt", "content": "A\nA"}, context)
    assert created.output["bytes_written"] == 3
    with pytest.raises(ToolInputError, match="文件已存在"):
        await write_tool.execute({"path": "notes.txt", "content": "B"}, context)
    with pytest.raises(ToolInputError, match="出现多次"):
        await edit_tool.execute({"path": "notes.txt", "old_text": "A", "new_text": "B"}, context)

    edited = await edit_tool.execute(
        {
            "path": "notes.txt",
            "old_text": "A",
            "new_text": "B",
            "replace_all": True,
        },
        context,
    )

    assert edited.output["replacements"] == 2
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "B\nB"


async def test_list_search_and_read_return_workspace_relative_evidence(tmp_path: Path) -> None:
    """只读工具返回稳定相对路径、行号和文件内容。"""
    workspace = tmp_path / "workspace"
    source = workspace / "src"
    source.mkdir(parents=True)
    (source / "agent.py").write_text("first\nAgent Loop\nlast\n", encoding="utf-8")
    registry = BuiltInToolRegistry()
    context = _context(workspace, PermissionProfile.READ_ONLY)
    list_tool = registry.get("list_files")
    search_tool = registry.get("search_text")
    read_tool = registry.get("read_file")
    assert list_tool is not None and search_tool is not None and read_tool is not None

    listed = await list_tool.execute({"path": ".", "recursive": True}, context)
    searched = await search_tool.execute(
        {"query": "agent loop", "path": "src", "glob": "*.py"}, context
    )
    read = await read_tool.execute(
        {"path": "src/agent.py", "start_line": 2, "end_line": 2}, context
    )

    assert any(entry["path"] == "src/agent.py" for entry in listed.output["entries"])
    assert searched.output["matches"] == [{"path": "src/agent.py", "line": 2, "text": "Agent Loop"}]
    assert read.output == {
        "path": "src/agent.py",
        "content": "Agent Loop",
        "truncated": False,
    }
