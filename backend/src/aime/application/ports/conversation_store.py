"""Session 对话与 Runtime 账本的持久化端口。"""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from aime.application.ports.model_gateway import ConversationMessage
from aime.domain.sessions.entities import AgentRun, AgentTurn, RuntimeEvent, SessionItem
from aime.domain.sessions.value_objects import PermissionProfile


@dataclass(frozen=True, slots=True)
class TurnExecution:
    """已经持久化、可以交给 Runtime 执行的一次 Turn。"""

    turn: AgentTurn
    run: AgentRun
    instruction: str
    messages: tuple[ConversationMessage, ...]
    newly_created: bool
    workspace_path: str = ""
    permission_profile: PermissionProfile = PermissionProfile.READ_ONLY


class ConversationStore(Protocol):
    """以原子操作维护 Turn、Run、Event 与 Item。"""

    async def start_turn(
        self,
        *,
        session_id: UUID,
        instruction: str,
        client_request_id: str,
    ) -> TurnExecution: ...

    async def mark_run_started(self, execution: TurnExecution) -> bool: ...

    async def mark_run_waiting(self, execution: TurnExecution) -> bool: ...

    async def mark_run_resumed(self, execution: TurnExecution) -> bool: ...

    async def complete_run(self, execution: TurnExecution, response_text: str) -> bool: ...

    async def append_run_event(
        self,
        execution: TurnExecution,
        event_type: str,
        payload: dict[str, object],
    ) -> RuntimeEvent: ...

    async def fail_run(self, execution: TurnExecution, message: str) -> bool: ...

    async def interrupt_run(self, execution: TurnExecution) -> bool: ...

    async def recover_incomplete_runs(self) -> int: ...

    async def list_resumable_executions(self) -> list[TurnExecution]: ...

    async def get_active_turn(self, session_id: UUID) -> AgentTurn | None: ...

    async def get_turn_by_client_request(
        self,
        session_id: UUID,
        client_request_id: str,
    ) -> AgentTurn | None: ...

    async def list_items(self, session_id: UUID, after_sequence: int = 0) -> list[SessionItem]: ...

    async def list_events(
        self,
        session_id: UUID,
        after_sequence: int = 0,
    ) -> list[RuntimeEvent]: ...
