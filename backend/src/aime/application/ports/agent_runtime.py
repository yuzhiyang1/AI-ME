"""Agent Runtime 端口。"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class AgentRunRequest:
    """提交给 Agent Runtime 的最小运行请求。"""

    instruction: str
    session_id: str


@dataclass(frozen=True, slots=True)
class AgentEvent:
    """与具体 Agent 框架无关的运行事件。"""

    type: str
    content: str


class AgentRuntime(Protocol):
    """AI-ME 自研 Python Agent Runtime 将实现的应用端口。"""

    def run(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        """执行一次 Agent Run 并流式返回标准事件。"""
        ...
