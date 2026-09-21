"""受工作区边界和输出上限保护的内置工具。"""

import asyncio
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

from aime.application.ports.model_gateway import LlmToolDefinition
from aime.application.ports.tool_execution import (
    AgentTool,
    ToolDescriptor,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolExecutionSemantics,
    ToolRegistry,
    ToolRiskLevel,
)
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.persistence.local_artifact_store import LocalArtifactStore
from aime.infrastructure.tools.file_change import build_file_change, read_before_write

MAX_FILE_CHARS = 200_000
MAX_LIST_ENTRIES = 2_000
MAX_SEARCH_MATCHES = 200
MAX_COMMAND_CHARS = 100_000


class ToolInputError(ValueError):
    """模型给出的工具参数无法安全执行。"""


class BuiltInToolRegistry(ToolRegistry):
    """注册 AI-ME 第一期的文件与 PowerShell 工具。"""

    def __init__(self, artifacts: LocalArtifactStore | None = None) -> None:
        tools: tuple[AgentTool, ...] = (
            ListFilesTool(),
            SearchTextTool(),
            ReadFileTool(artifacts),
            WriteFileTool(),
            EditFileTool(),
            PowerShellTool(artifacts),
        )
        self._tools = {tool.descriptor.definition.name: tool for tool in tools}

    def descriptors(self, permission: PermissionProfile) -> tuple[ToolDescriptor, ...]:
        """只向模型暴露当前权限档位允许请求的工具。"""
        return tuple(
            tool.descriptor
            for tool in self._tools.values()
            if _permission_allows(permission, tool.descriptor.risk_level)
        )

    def get(self, name: str) -> AgentTool | None:
        return self._tools.get(name)


class ListFilesTool:
    """列出工作区中的文件和目录。"""

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            name="list_files",
            description="列出工作区目录中的文件和子目录。path 必须位于工作区内。",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区的目录，默认 ."},
                    "recursive": {"type": "boolean", "default": False},
                },
                "additionalProperties": False,
            },
        ),
        execution_semantics=ToolExecutionSemantics.PARALLEL,
        risk_level=ToolRiskLevel.READ,
    )

    async def execute(
        self, arguments: dict[str, object], context: ToolExecutionContext
    ) -> ToolExecutionResult:
        path = _workspace_path(context, _optional_string(arguments, "path", "."), must_exist=True)
        recursive = _optional_bool(arguments, "recursive", False)
        if not path.is_dir():
            raise ToolInputError("path 必须指向目录")
        entries = await asyncio.to_thread(_list_entries, path, recursive, context)
        truncated = len(entries) > MAX_LIST_ENTRIES
        return ToolExecutionResult(
            {
                "path": _relative(path, context),
                "entries": entries[:MAX_LIST_ENTRIES],
                "truncated": truncated,
            }
        )


class SearchTextTool:
    """在工作区文本文件中搜索正则表达式。"""

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            name="search_text",
            description="在工作区文件中搜索文本或正则表达式，返回文件、行号和匹配行。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "path": {"type": "string", "default": "."},
                    "glob": {"type": "string", "description": "可选文件名 glob，例如 *.py"},
                    "case_sensitive": {"type": "boolean", "default": False},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        ),
        execution_semantics=ToolExecutionSemantics.PARALLEL,
        risk_level=ToolRiskLevel.READ,
    )

    async def execute(
        self, arguments: dict[str, object], context: ToolExecutionContext
    ) -> ToolExecutionResult:
        query = _required_string(arguments, "query")
        path = _workspace_path(context, _optional_string(arguments, "path", "."), must_exist=True)
        glob = _optional_string(arguments, "glob", "")
        case_sensitive = _optional_bool(arguments, "case_sensitive", False)
        try:
            pattern = re.compile(query, 0 if case_sensitive else re.IGNORECASE)
        except re.error as exc:
            raise ToolInputError(f"query 不是有效正则表达式：{exc}") from exc
        matches, truncated = await asyncio.to_thread(
            _search_files, path, pattern, glob or None, context
        )
        return ToolExecutionResult({"matches": matches, "truncated": truncated})


class ReadFileTool:
    """读取工作区内的 UTF-8 文本文件。"""

    def __init__(self, artifacts: LocalArtifactStore | None = None) -> None:
        self._artifacts = artifacts

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            name="read_file",
            description="读取工作区内 UTF-8 文本文件，可指定一基行号范围。",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer", "minimum": 1},
                    "end_line": {"type": "integer", "minimum": 1},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        ),
        execution_semantics=ToolExecutionSemantics.PARALLEL,
        risk_level=ToolRiskLevel.READ,
    )

    async def execute(
        self, arguments: dict[str, object], context: ToolExecutionContext
    ) -> ToolExecutionResult:
        path = _workspace_path(context, _required_string(arguments, "path"), must_exist=True)
        if not path.is_file():
            raise ToolInputError("path 必须指向文件")
        start_line = _optional_positive_int(arguments, "start_line", 1)
        end_line = _optional_positive_int(arguments, "end_line", None)
        assert start_line is not None
        if end_line is not None and end_line < start_line:
            raise ToolInputError("end_line 不能小于 start_line")
        if self._artifacts is not None:
            captured = await self._artifacts.capture(
                context.session_id,
                _file_chunks(path, start_line, end_line),
            )
            return ToolExecutionResult(
                {
                    "path": _relative(path, context),
                    "content": captured.pop("preview"),
                    **captured,
                }
            )
        selected = await _bounded_file_text(path, start_line, end_line)
        truncated = len(selected) > MAX_FILE_CHARS
        return ToolExecutionResult(
            {
                "path": _relative(path, context),
                "content": selected[:MAX_FILE_CHARS],
                "truncated": truncated,
            }
        )


class WriteFileTool:
    """原子创建或覆盖工作区内的文本文件。"""

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            name="write_file",
            description="以 UTF-8 原子写入工作区文件。父目录必须已经存在。",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "overwrite": {"type": "boolean", "default": False},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        ),
        execution_semantics=ToolExecutionSemantics.EXCLUSIVE_STEP,
        risk_level=ToolRiskLevel.WORKSPACE_WRITE,
    )

    async def execute(
        self, arguments: dict[str, object], context: ToolExecutionContext
    ) -> ToolExecutionResult:
        path = _workspace_path(context, _required_string(arguments, "path"), must_exist=False)
        content = _required_string(arguments, "content", allow_empty=True)
        overwrite = _optional_bool(arguments, "overwrite", False)
        if not path.parent.is_dir():
            raise ToolInputError("目标文件的父目录不存在")
        existed = path.exists()
        if existed and not overwrite:
            raise ToolInputError("文件已存在；确认覆盖时请设置 overwrite=true")
        # 只比较本次写入的原文件，不使用 Git 基线，保留用户此前已有的改动。
        before, reason = await asyncio.to_thread(read_before_write, path)
        change = await asyncio.to_thread(
            build_file_change,
            _relative(path, context),
            before,
            content,
            created=not existed,
            unavailable_reason=reason,
        )
        await asyncio.to_thread(_atomic_write, path, content)
        return ToolExecutionResult(
            {
                "path": _relative(path, context),
                "bytes_written": len(content.encode("utf-8")),
                "file_change": change,
            }
        )


class EditFileTool:
    """按唯一原文片段精确编辑工作区文件。"""

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            name="edit_file",
            description="替换工作区文件中的精确文本；默认要求 old_text 只出现一次。",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                    "replace_all": {"type": "boolean", "default": False},
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": False,
            },
        ),
        execution_semantics=ToolExecutionSemantics.EXCLUSIVE_STEP,
        risk_level=ToolRiskLevel.WORKSPACE_WRITE,
    )

    async def execute(
        self, arguments: dict[str, object], context: ToolExecutionContext
    ) -> ToolExecutionResult:
        path = _workspace_path(context, _required_string(arguments, "path"), must_exist=True)
        old_text = _required_string(arguments, "old_text")
        new_text = _required_string(arguments, "new_text", allow_empty=True)
        replace_all = _optional_bool(arguments, "replace_all", False)
        # 不让文本读取隐式将 CRLF 改成 LF，否则局部编辑会产生整文件换行差异。
        content = await asyncio.to_thread(_read_exact_text, path)
        occurrences = content.count(old_text)
        if occurrences == 0:
            raise ToolInputError("old_text 在文件中不存在")
        if occurrences > 1 and not replace_all:
            raise ToolInputError("old_text 出现多次；请提供更精确内容或设置 replace_all=true")
        updated = content.replace(old_text, new_text, -1 if replace_all else 1)
        change = await asyncio.to_thread(
            build_file_change,
            _relative(path, context),
            content,
            updated,
        )
        await asyncio.to_thread(_atomic_write, path, updated)
        return ToolExecutionResult(
            {
                "path": _relative(path, context),
                "replacements": occurrences if replace_all else 1,
                "file_change": change,
            }
        )


class PowerShellTool:
    """在工作区中以非交互方式执行 PowerShell。"""

    def __init__(self, artifacts: LocalArtifactStore | None = None) -> None:
        self._artifacts = artifacts

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            name="run_powershell",
            description="在会话工作区执行非交互 PowerShell 命令。",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 120},
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        ),
        execution_semantics=ToolExecutionSemantics.EXCLUSIVE_STEP,
        risk_level=ToolRiskLevel.SHELL,
    )

    async def execute(
        self, arguments: dict[str, object], context: ToolExecutionContext
    ) -> ToolExecutionResult:
        command = _required_string(arguments, "command")
        timeout = _optional_positive_int(arguments, "timeout_seconds", 30)
        if timeout is None or timeout > 120:
            raise ToolInputError("timeout_seconds 必须在 1 到 120 之间")
        creationflags = 0
        if sys.platform == "win32":
            # 显式分支让运行时与跨平台类型检查都只在 Windows 访问专用常量。
            creationflags = subprocess.CREATE_NO_WINDOW
        process = await asyncio.create_subprocess_exec(
            # Windows 保留内置解释器；Linux/macOS 使用 PowerShell 7 的命令名。
            "powershell.exe" if sys.platform == "win32" else "pwsh",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
            cwd=context.workspace_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=creationflags,
        )
        assert process.stdout is not None and process.stderr is not None

        async def collect(stream: asyncio.StreamReader) -> dict[str, object]:
            if self._artifacts is not None:
                return await self._artifacts.capture(context.session_id, _pipe_chunks(stream))
            buffer = bytearray()
            total = 0
            async for chunk in _pipe_chunks(stream):
                total += len(chunk)
                buffer.extend(chunk[: max(0, MAX_COMMAND_CHARS * 4 - len(buffer))])
            decoded = buffer.decode("utf-8", errors="replace")
            return {
                "preview": decoded[:MAX_COMMAND_CHARS],
                "truncated": total > len(buffer) or len(decoded) > MAX_COMMAND_CHARS,
            }

        collectors = asyncio.gather(collect(process.stdout), collect(process.stderr))
        try:
            stdout_result, stderr_result = await asyncio.wait_for(collectors, timeout)
            await asyncio.wait_for(process.wait(), timeout)
        except TimeoutError:
            if process.returncode is None:
                process.kill()
            await process.wait()
            return ToolExecutionResult(
                {
                    "error": f"命令超过 {timeout} 秒后已终止",
                    "timed_out": True,
                    "capture_complete": False,
                },
                is_error=True,
            )
        except BaseException:
            # 取消、磁盘失败等路径也必须关闭进程和采集任务，不能遗留后台写入。
            collectors.cancel()
            if process.returncode is None:
                process.kill()
            await process.wait()
            await asyncio.gather(collectors, return_exceptions=True)
            raise
        return ToolExecutionResult(
            {
                "exit_code": process.returncode,
                "stdout": stdout_result.pop("preview"),
                "stderr": stderr_result.pop("preview"),
                "stdout_artifact": stdout_result,
                "stderr_artifact": stderr_result,
                "truncated": stdout_result["truncated"] or stderr_result["truncated"],
            },
            is_error=process.returncode != 0,
        )


async def _pipe_chunks(stream: asyncio.StreamReader) -> AsyncIterator[bytes]:
    while chunk := await stream.read(65_536):
        yield chunk


async def _file_chunks(path: Path, start: int, end: int | None) -> AsyncIterator[bytes]:
    """按逻辑行筛选，readline 同时设长度上限，超长单行不造成内存尖峰。"""
    with path.open("r", encoding="utf-8", errors="strict", newline=None) as handle:
        line = 1
        emitted = False
        new_line = True
        while chunk := await asyncio.to_thread(handle.readline, 16_384):
            if end is not None and line > end:
                break
            ends_line = chunk.endswith("\n")
            if line >= start:
                prefix = "\n" if emitted and new_line else ""
                yield (prefix + (chunk[:-1] if ends_line else chunk)).encode("utf-8")
                emitted = True
            new_line = ends_line
            if ends_line:
                line += 1


async def _bounded_file_text(path: Path, start: int, end: int | None) -> str:
    parts: list[str] = []
    size = 0
    async for chunk in _file_chunks(path, start, end):
        decoded = chunk.decode("utf-8")
        parts.append(decoded[: max(0, MAX_FILE_CHARS + 1 - size)])
        size += len(decoded)
        if size > MAX_FILE_CHARS:
            break
    return "".join(parts)


def _permission_allows(permission: PermissionProfile, risk: ToolRiskLevel) -> bool:
    ranks = {
        PermissionProfile.READ_ONLY: 0,
        PermissionProfile.WORKSPACE_WRITE: 1,
        PermissionProfile.FULL_ACCESS: 2,
    }
    required = {
        ToolRiskLevel.READ: 0,
        ToolRiskLevel.WORKSPACE_WRITE: 1,
        ToolRiskLevel.SHELL: 1,
    }
    return ranks[permission] >= required[risk]


def _workspace_path(context: ToolExecutionContext, raw_path: str, *, must_exist: bool) -> Path:
    """解析路径，并在跟随现有链接后验证全部 Session 授权 roots。"""
    roots = tuple(
        Path(root).resolve(strict=True)
        for root in (context.workspace_roots or (context.workspace_path,))
    )
    candidate = Path(raw_path)
    unresolved = candidate if candidate.is_absolute() else roots[0] / candidate
    try:
        resolved = unresolved.resolve(strict=must_exist)
    except (FileNotFoundError, OSError) as exc:
        raise ToolInputError(f"path 不存在或无法访问：{raw_path}") from exc
    if not any(_is_within(resolved, root) for root in roots):
        raise ToolInputError("path 不能离开会话授权工作区")
    return resolved


def _relative(path: Path, context: ToolExecutionContext) -> str:
    """主目录内返回相对路径；附加目录返回无歧义的规范化绝对路径。"""
    primary = Path(context.workspace_path).resolve(strict=True)
    try:
        return path.relative_to(primary).as_posix() or "."
    except ValueError:
        return str(path)


def _is_within(path: Path, root: Path) -> bool:
    """使用平台路径规则判断目标是否位于一个授权 root 内。"""
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _required_string(arguments: dict[str, object], name: str, *, allow_empty: bool = False) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ToolInputError(f"{name} 必须是{'可为空的' if allow_empty else '非空'}字符串")
    return value


def _optional_string(arguments: dict[str, object], name: str, default: str) -> str:
    value = arguments.get(name, default)
    if not isinstance(value, str):
        raise ToolInputError(f"{name} 必须是字符串")
    return value


def _optional_bool(arguments: dict[str, object], name: str, default: bool) -> bool:
    value = arguments.get(name, default)
    if not isinstance(value, bool):
        raise ToolInputError(f"{name} 必须是布尔值")
    return value


def _optional_positive_int(
    arguments: dict[str, object], name: str, default: int | None
) -> int | None:
    value = arguments.get(name, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ToolInputError(f"{name} 必须是正整数")
    return value


def _list_entries(
    path: Path,
    recursive: bool,
    context: ToolExecutionContext,
) -> list[dict[str, object]]:
    iterator = path.rglob("*") if recursive else path.iterdir()
    entries: list[dict[str, object]] = []
    for entry in iterator:
        # 列表工具不跟随链接，避免仅通过 stat 就泄漏授权目录之外的元数据。
        if entry.is_symlink():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        entries.append(
            {
                "path": _relative(entry.resolve(), context),
                "type": "directory" if entry.is_dir() else "file",
                "size": stat.st_size if entry.is_file() else None,
            }
        )
        if len(entries) > MAX_LIST_ENTRIES:
            break
    return sorted(entries, key=lambda item: str(item["path"]).lower())


def _search_files(
    path: Path,
    pattern: re.Pattern[str],
    glob: str | None,
    context: ToolExecutionContext,
) -> tuple[list[dict[str, object]], bool]:
    files = [path] if path.is_file() else path.rglob(glob or "*")
    matches: list[dict[str, object]] = []
    for file_path in files:
        if not file_path.is_file() or file_path.is_symlink():
            continue
        try:
            with file_path.open("r", encoding="utf-8", errors="strict") as handle:
                for line_number, line in enumerate(handle, start=1):
                    if pattern.search(line):
                        matches.append(
                            {
                                "path": _relative(file_path.resolve(), context),
                                "line": line_number,
                                "text": line.rstrip("\r\n")[:2_000],
                            }
                        )
                        if len(matches) >= MAX_SEARCH_MATCHES:
                            return matches, True
        except (OSError, UnicodeError):
            continue
    return matches, False


def _read_exact_text(path: Path) -> str:
    with path.open("r", encoding="utf-8", errors="strict", newline="") as handle:
        return handle.read()


def _atomic_write(path: Path, content: str) -> None:
    """在同一目录写临时文件并原子替换，避免留下半文件。"""
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
