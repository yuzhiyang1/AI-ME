"""Turn 与 Item 应用用例。"""

from dataclasses import dataclass
from uuid import UUID

from aime.application.ports.conversation_store import ConversationStore
from aime.application.sessions.exceptions import TurnNotActive
from aime.application.sessions.runtime_coordinator import RuntimeCoordinator
from aime.domain.sessions.entities import AgentTurn, RuntimeEvent, SessionItem


@dataclass(frozen=True, slots=True)
class StartTurnCommand:
    """开始一次用户 Turn 的输入。"""

    session_id: UUID
    instruction: str
    client_request_id: str


class StartTurn:
    """先持久化 Turn，再交给后台 Runtime 执行。"""

    def __init__(self, store: ConversationStore, coordinator: RuntimeCoordinator) -> None:
        self._store = store
        self._coordinator = coordinator

    async def execute(self, command: StartTurnCommand) -> AgentTurn:
        """创建或返回幂等 Turn，并触发首次执行。"""
        instruction = command.instruction.strip()
        if not instruction:
            raise ValueError("Turn 输入不能为空")
        client_request_id = command.client_request_id.strip()
        if not client_request_id:
            raise ValueError("clientRequestId 不能为空")
        execution = await self._store.start_turn(
            session_id=command.session_id,
            instruction=instruction,
            client_request_id=client_request_id,
        )
        self._coordinator.submit(execution)
        return execution.turn


class ListSessionItems:
    """按 sequence 读取客户端可见 Item。"""

    def __init__(self, store: ConversationStore) -> None:
        self._store = store

    async def execute(self, session_id: UUID, after_sequence: int = 0) -> list[SessionItem]:
        """返回指定游标之后的持久 Item。"""
        return await self._store.list_items(session_id, after_sequence)


class ListRuntimeEvents:
    """按 sequence 读取可重放的 RuntimeEvent。"""

    def __init__(self, store: ConversationStore) -> None:
        self._store = store

    async def execute(self, session_id: UUID, after_sequence: int = 0) -> list[RuntimeEvent]:
        """返回指定游标之后的不可变运行事实。"""
        return await self._store.list_events(session_id, after_sequence)


class GetActiveTurn:
    """读取客户端恢复执行控制所需的当前活跃 Turn。"""

    def __init__(self, store: ConversationStore) -> None:
        self._store = store

    async def execute(self, session_id: UUID) -> AgentTurn | None:
        """不存在活跃 Turn 时返回 None；Session 不存在仍返回 404 语义。"""
        return await self._store.get_active_turn(session_id)


class GetTurnByClientRequest:
    """对账一次响应结果不确定的 Turn 创建请求。"""

    def __init__(self, store: ConversationStore) -> None:
        self._store = store

    async def execute(self, session_id: UUID, client_request_id: str) -> AgentTurn | None:
        """幂等键没有对应事实时返回 None。"""
        normalized = client_request_id.strip()
        if not normalized:
            raise ValueError("clientRequestId 不能为空")
        return await self._store.get_turn_by_client_request(session_id, normalized)


class InterruptTurn:
    """由用户主动中断一条活跃 Turn。"""

    def __init__(self, coordinator: RuntimeCoordinator) -> None:
        self._coordinator = coordinator

    async def execute(self, session_id: UUID, turn_id: UUID) -> None:
        """取消执行；已经结束或归属不符时返回稳定冲突。"""
        interrupted = await self._coordinator.interrupt(session_id, turn_id)
        if not interrupted:
            raise TurnNotActive("Turn 不属于该 Session 或已经结束")
