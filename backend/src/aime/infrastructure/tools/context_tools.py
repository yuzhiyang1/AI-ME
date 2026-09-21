"""上下文工具通过正常 T1/T2 账本执行，内部存储不扩展工作区权限。"""

from typing import Any

from aime.application.context.service import RunContext
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


def _schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, object]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


STRING = {"type": "string"}
INTEGER = {"type": "integer", "minimum": 0}
CHECKPOINT_FIELDS = (
    "goal",
    "progress",
    "constraints",
    "decisions",
    "failed_attempts",
    "next_steps",
)
SPECS = (
    ("get_context_remaining", "查看剩余输入预算、Checkpoint 版本和最新历史序号。", _schema({})),
    ("new_context", "申请在当前工具结果落盘后启动新窗口。", _schema({})),
    (
        "write_checkpoint",
        "更新任务接续笔记；references 是 history item ID，版本从 get_context_remaining 获取。",
        _schema(
            {
                **dict.fromkeys(CHECKPOINT_FIELDS, STRING),
                "expected_version": INTEGER,
                "covered_sequence": INTEGER,
                "references": {"type": "array", "items": {"type": "integer"}},
            },
            [*CHECKPOINT_FIELDS, "expected_version", "covered_sequence", "references"],
        ),
    ),
    (
        "history_list",
        "分页列出历史条目和窗口 ID。",
        _schema(
            {
                "after": INTEGER,
                "window_id": STRING,
                "role": STRING,
                "tool": STRING,
            }
        ),
    ),
    (
        "history_search",
        "按关键词检索已保存历史，结果有界。",
        _schema(
            {
                "query": STRING,
                "after": INTEGER,
                "window_id": STRING,
                "role": STRING,
                "tool": STRING,
            },
            ["query"],
        ),
    ),
    (
        "history_read",
        "按字符偏移读取历史条目，最多 4000 字符。",
        _schema(
            {
                "item_id": INTEGER,
                "offset": INTEGER,
                "limit": {"type": "integer", "minimum": 1},
            },
            ["item_id"],
        ),
    ),
    (
        "artifact_read",
        "按字节偏移读取产物，最多 4000 字节，使用 next_offset 翻页。",
        _schema(
            {
                "artifact_id": STRING,
                "offset": INTEGER,
                "limit": {"type": "integer", "minimum": 1},
            },
            ["artifact_id"],
        ),
    ),
    (
        "artifact_search",
        "按关键词搜索产物，最多扫描 64 KiB，使用 next_offset 继续。",
        _schema(
            {
                "artifact_id": STRING,
                "query": STRING,
                "offset": INTEGER,
            },
            ["artifact_id", "query"],
        ),
    ),
)


class ContextToolRegistry:
    """每个 Run 包装一次注册表，避免并发 Session 共享可变上下文。"""

    def __init__(self, base: ToolRegistry, context: RunContext) -> None:
        self._base = base
        self._tools: dict[str, AgentTool] = {
            name: ContextTool(name, description, schema, context)
            for name, description, schema in SPECS
        }

    def descriptors(self, permission: PermissionProfile) -> tuple[ToolDescriptor, ...]:
        return self._base.descriptors(permission) + tuple(
            tool.descriptor for tool in self._tools.values()
        )

    def get(self, name: str) -> AgentTool | None:
        return self._tools.get(name) or self._base.get(name)


class ContextTool:
    """将模型参数映射到会话内存储操作，不向模型开放内部存储目录。"""

    def __init__(
        self, name: str, description: str, schema: dict[str, object], context: RunContext
    ) -> None:
        self._context = context
        self._name = name
        # 笔记和换窗申请独占步骤；READ 风险指不修改用户工作区，并非不写内部状态。
        self.descriptor = ToolDescriptor(
            LlmToolDefinition(name, description, schema),
            ToolExecutionSemantics.EXCLUSIVE_STEP
            if name in {"write_checkpoint", "new_context"}
            else ToolExecutionSemantics.PARALLEL,
            ToolRiskLevel.READ,
        )

    async def execute(
        self,
        arguments: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        """以 Runtime 注入的会话身份访问预算、笔记、历史或产物，返回可落 T2 的结果。

        工具不直接切换窗口；换窗申请需先完成当前批次落盘，再由 Runtime 处理。
        """
        state = self._context
        sid = context.session_id
        name = self._name
        if name == "get_context_remaining":
            checkpoint = await state.store.checkpoint(sid)
            window = await state.store.window(sid)
            result = {
                "remaining_tokens": state.remaining,
                "estimated": True,
                "checkpoint_version": checkpoint.version,
                "latest_sequence": await state.store.latest_sequence(sid),
                "window_id": window.id,
                "window_number": window.number,
            }
        elif name == "new_context":
            # 此处只返回申请事实，不能在工具仍未完成时修改活动窗口。
            result = {"new_context_requested": True}
        elif name == "write_checkpoint":
            saved = await state.store.write_checkpoint(
                sid,
                context.run_id,
                context.call_id,
                arguments["expected_version"],
                arguments["covered_sequence"],
                {key: arguments[key] for key in (*CHECKPOINT_FIELDS, "references")},
            )
            result = {
                "checkpoint_version": saved.version,
                "covered_sequence": saved.covered_sequence,
            }
        elif name in {"history_list", "history_search"}:
            result = await state.store.history(sid, **arguments)
        elif name == "history_read":
            result = await state.store.read_history(sid, **arguments)
        elif name == "artifact_read":
            result = await state.artifacts.read(sid, **arguments)
        else:
            result = await state.artifacts.search(sid, **arguments)
        return ToolExecutionResult(result)
