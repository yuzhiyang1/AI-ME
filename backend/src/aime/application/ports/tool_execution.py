"""Agent 工具注册与执行端口。"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from aime.application.ports.model_gateway import LlmToolDefinition
from aime.domain.sessions.value_objects import PermissionProfile


class ToolExecutionSemantics(StrEnum):
    """同一模型步骤内的工具调度语义。"""

    PARALLEL = "parallel"
    EXCLUSIVE_STEP = "exclusive_step"


class ToolRiskLevel(StrEnum):
    """工具可能产生的最高副作用等级。"""

    READ = "read"
    WORKSPACE_WRITE = "workspace_write"
    SHELL = "shell"


@dataclass(frozen=True, slots=True)
class ToolDescriptor:
    """Runtime 用于发现、授权和调度工具的稳定元数据。"""

    definition: LlmToolDefinition
    execution_semantics: ToolExecutionSemantics
    risk_level: ToolRiskLevel


@dataclass(frozen=True, slots=True)
class ToolExecutionContext:
    """执行工具所需的会话边界，不向工具暴露基础设施对象。"""

    session_id: str
    turn_id: str
    run_id: str
    workspace_path: str
    permission_profile: PermissionProfile
    workspace_roots: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ToolExecutionResult:
    """工具返回给模型的 JSON 兼容结果。"""

    output: dict[str, object]
    is_error: bool = False


class AgentTool(Protocol):
    """一个可被 Agent Runtime 调用的工具。"""

    @property
    def descriptor(self) -> ToolDescriptor: ...

    async def execute(
        self,
        arguments: dict[str, object],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult: ...


class ToolRegistry(Protocol):
    """按会话权限暴露可用工具，并按名称解析执行器。"""

    def descriptors(self, permission: PermissionProfile) -> tuple[ToolDescriptor, ...]: ...

    def get(self, name: str) -> AgentTool | None: ...
