"""Agent Session 仓储端口。"""

from typing import Protocol

from aime.domain.sessions.entities import AgentSession
from aime.domain.sessions.value_objects import SessionId


class SessionRepository(Protocol):
    """由基础设施层实现的 Session 持久化端口。"""

    async def add(self, session: AgentSession) -> None: ...

    async def get(self, session_id: SessionId) -> AgentSession | None: ...

    async def list_all(self) -> list[AgentSession]: ...
