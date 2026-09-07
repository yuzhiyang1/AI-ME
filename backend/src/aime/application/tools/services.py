"""工具调用账本查询服务。"""

from uuid import UUID

from aime.application.ports.tool_execution_store import ToolExecutionStore
from aime.domain.tool_execution.entities import ToolInvocation


class ListToolInvocations:
    """按执行顺序读取一条 Session 的工具审计记录。"""

    def __init__(self, store: ToolExecutionStore) -> None:
        self._store = store

    async def execute(self, session_id: UUID) -> list[ToolInvocation]:
        return await self._store.list_session_invocations(session_id)
