"""Skill 工具复用现有执行账本和共享结果预算。"""

from typing import Any

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
from aime.application.skill_service import SkillRun
from aime.domain.sessions.value_objects import PermissionProfile
from aime.domain.skills import SkillError


class SkillTool:
    """模型只能搜索或读取，不接受执行脚本之类的额外动作。"""

    def __init__(self, run: SkillRun, name: str) -> None:
        self.run = run
        search = name == "skill_search"
        fields: dict[str, Any] = {
            "query" if search else "ref": {"type": "string"},
            "cursor": {"type": "string"},
        }
        fields.update(
            {"limit": {"type": "integer", "minimum": 1, "maximum": 8}}
            if search
            else {"resource": {"type": "string"}}
        )
        self.descriptor = ToolDescriptor(
            LlmToolDefinition(
                name,
                "搜索可用 Skill 简介，支持中文。"
                if search
                else "按 ref 分页读取 Skill 或相对附件。complete=false 时继续 next_cursor。",
                {
                    "type": "object",
                    "properties": fields,
                    "required": ["query" if search else "ref"],
                    "additionalProperties": False,
                },
            ),
            ToolExecutionSemantics.PARALLEL,
            ToolRiskLevel.READ,
        )

    async def execute(
        self,
        arguments: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            if self.descriptor.definition.name == "skill_search":
                result = await self.run.search(**arguments)
            else:
                result = await self.run.read(**arguments)
            return ToolExecutionResult(result)
        except (SkillError, OSError, UnicodeError) as exc:
            return ToolExecutionResult({"error": str(exc)}, is_error=True)


class SkillToolRegistry:
    """按 Run 组合工具，不修改其他会话的注册表。"""

    def __init__(self, base: ToolRegistry, run: SkillRun) -> None:
        self.base = base
        self.tools = {name: SkillTool(run, name) for name in ("skill_search", "skill_read")}

    def descriptors(self, permission: PermissionProfile) -> tuple[ToolDescriptor, ...]:
        return self.base.descriptors(permission) + tuple(t.descriptor for t in self.tools.values())

    def get(self, name: str) -> AgentTool | None:
        return self.tools.get(name) or self.base.get(name)
