"""应用装配根。所有具体实现只在这里接线。"""

import os
from dataclasses import dataclass
from pathlib import Path

from aime.application.models.services import ListAvailableModels, StreamModelCompletion
from aime.application.ports.conversation_store import ConversationStore
from aime.application.ports.model_gateway import ModelGateway
from aime.application.sessions.runtime_coordinator import RuntimeCoordinator
from aime.application.sessions.services import CreateSession, GetSession, ListSessions
from aime.application.sessions.turn_services import (
    GetActiveTurn,
    GetTurnByClientRequest,
    InterruptTurn,
    ListRuntimeEvents,
    ListSessionItems,
    StartTurn,
)
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.infrastructure.llm.model_gateway_impl import build_gateway_from_env
from aime.infrastructure.persistence.in_memory_work_item_repository import (
    InMemoryWorkItemRepository,
)
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository
from aime.infrastructure.runtime.model_agent_runtime import ModelAgentRuntime


@dataclass(slots=True)
class Container:
    """模块化单体的依赖容器。"""

    create_work_item: CreateWorkItem
    list_work_items: ListWorkItems
    list_available_models: ListAvailableModels
    stream_model_completion: StreamModelCompletion
    create_session: CreateSession
    get_session: GetSession
    list_sessions: ListSessions
    start_turn: StartTurn
    get_active_turn: GetActiveTurn
    get_turn_by_client_request: GetTurnByClientRequest
    list_session_items: ListSessionItems
    list_runtime_events: ListRuntimeEvents
    interrupt_turn: InterruptTurn
    runtime_coordinator: RuntimeCoordinator
    conversation_store: ConversationStore
    database: SqliteDatabase

    async def initialize(self) -> None:
        """初始化需要进程生命周期管理的基础设施。"""
        await self.database.initialize()
        await self.conversation_store.recover_incomplete_runs()

    async def close(self) -> None:
        """按装配根拥有的顺序关闭基础设施。"""
        await self.runtime_coordinator.close()
        await self.database.close()


def build_container(
    *,
    state_dir: Path | None = None,
    model_gateway: ModelGateway | None = None,
) -> Container:
    """创建应用所需的依赖图。

    模型网关按环境变量装配：未配置任何 AIME_*_API_KEY 时得到
    空模型列表的网关（不加载任何厂商 SDK），其余用例不受影响。
    """
    work_items = InMemoryWorkItemRepository()
    resolved_model_gateway = model_gateway or build_gateway_from_env()
    resolved_state_dir = state_dir or _default_state_dir()
    database = SqliteDatabase(resolved_state_dir)
    sessions = SqliteSessionRepository(database.session_factory)
    conversation_store = SqliteConversationStore(database.session_factory)
    agent_runtime = ModelAgentRuntime(resolved_model_gateway)
    runtime_coordinator = RuntimeCoordinator(agent_runtime, conversation_store)
    return Container(
        create_work_item=CreateWorkItem(work_items),
        list_work_items=ListWorkItems(work_items),
        list_available_models=ListAvailableModels(resolved_model_gateway),
        stream_model_completion=StreamModelCompletion(resolved_model_gateway),
        create_session=CreateSession(sessions),
        get_session=GetSession(sessions),
        list_sessions=ListSessions(sessions),
        start_turn=StartTurn(conversation_store, runtime_coordinator),
        get_active_turn=GetActiveTurn(conversation_store),
        get_turn_by_client_request=GetTurnByClientRequest(conversation_store),
        list_session_items=ListSessionItems(conversation_store),
        list_runtime_events=ListRuntimeEvents(conversation_store),
        interrupt_turn=InterruptTurn(runtime_coordinator),
        runtime_coordinator=runtime_coordinator,
        conversation_store=conversation_store,
        database=database,
    )


def _default_state_dir() -> Path:
    """返回可覆盖的本地应用状态目录。"""
    configured = os.environ.get("AIME_STATE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "AI-ME" / "state"
    return Path.home() / ".ai-me" / "state"
