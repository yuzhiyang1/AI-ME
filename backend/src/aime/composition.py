"""应用装配根。所有具体实现只在这里接线。"""

import os
from dataclasses import dataclass
from pathlib import Path

from aime.application.approvals.services import DecideApproval, ListPendingApprovals
from aime.application.model_configurations.services import ModelConfigurationService
from aime.application.models.services import ListAvailableModels, StreamModelCompletion
from aime.application.ports.conversation_store import ConversationStore
from aime.application.ports.model_configuration import ModelCredentialStore
from aime.application.ports.model_gateway import ModelGateway
from aime.application.ports.tool_execution import ToolRegistry
from aime.application.ports.tool_execution_store import ToolExecutionStore
from aime.application.sessions.runtime_coordinator import RuntimeCoordinator
from aime.application.sessions.services import CreateSession, GetSession, ListSessions
from aime.application.sessions.turn_services import (
    GetActiveTurn,
    GetSessionTokenUsage,
    GetTurnByClientRequest,
    InterruptTurn,
    ListRuntimeEvents,
    ListSessionItems,
    StartTurn,
)
from aime.application.tools.services import ListToolInvocations
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.infrastructure.credentials.system_keyring import SystemModelCredentialStore
from aime.infrastructure.llm.configurable_gateway import ConfigurableModelGateway
from aime.infrastructure.llm.model_gateway_impl import build_gateway_from_env
from aime.infrastructure.persistence.in_memory_work_item_repository import (
    InMemoryWorkItemRepository,
)
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_model_configuration_repository import (
    SqliteModelConfigurationRepository,
)
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository
from aime.infrastructure.persistence.sqlite_tool_execution_store import SqliteToolExecutionStore
from aime.infrastructure.runtime.approval_broker import InMemoryApprovalBroker
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
    get_session_token_usage: GetSessionTokenUsage
    interrupt_turn: InterruptTurn
    list_pending_approvals: ListPendingApprovals
    decide_approval: DecideApproval
    list_tool_invocations: ListToolInvocations
    model_configuration_service: ModelConfigurationService
    runtime_coordinator: RuntimeCoordinator
    conversation_store: ConversationStore
    tool_execution_store: ToolExecutionStore
    database: SqliteDatabase

    async def initialize(self) -> None:
        """初始化需要进程生命周期管理的基础设施。"""
        await self.database.initialize()
        await self.model_configuration_service.initialize()
        await self.tool_execution_store.recover_unsettled_invocations()
        await self.conversation_store.recover_incomplete_runs()
        for execution in await self.conversation_store.list_resumable_executions():
            self.runtime_coordinator.resume(execution)

    async def close(self) -> None:
        """按装配根拥有的顺序关闭基础设施。"""
        await self.runtime_coordinator.close()
        await self.database.close()


def build_container(
    *,
    state_dir: Path | None = None,
    model_gateway: ModelGateway | None = None,
    model_credential_store: ModelCredentialStore | None = None,
    tool_registry: ToolRegistry | None = None,
) -> Container:
    """创建应用所需的依赖图。

    模型网关按环境变量装配：未配置任何 AIME_*_API_KEY 时得到
    空模型列表的网关（不加载任何厂商 SDK），其余用例不受影响。
    """
    work_items = InMemoryWorkItemRepository()
    environment_gateway = model_gateway or build_gateway_from_env()
    resolved_model_gateway = ConfigurableModelGateway(environment_gateway)
    resolved_state_dir = state_dir or _default_state_dir()
    database = SqliteDatabase(resolved_state_dir)
    model_configurations = SqliteModelConfigurationRepository(database.session_factory)
    credential_store = model_credential_store or SystemModelCredentialStore()
    model_configuration_service = ModelConfigurationService(
        model_configurations,
        credential_store,
        resolved_model_gateway,
    )
    sessions = SqliteSessionRepository(database.session_factory)
    conversation_store = SqliteConversationStore(database.session_factory)
    tool_execution_store = SqliteToolExecutionStore(database.session_factory)
    approval_broker = InMemoryApprovalBroker()
    agent_runtime = ModelAgentRuntime(
        resolved_model_gateway,
        tool_execution_store,
        approval_broker,
        tool_registry,
    )
    runtime_coordinator = RuntimeCoordinator(
        agent_runtime,
        conversation_store,
        tool_store=tool_execution_store,
    )
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
        get_session_token_usage=GetSessionTokenUsage(conversation_store),
        interrupt_turn=InterruptTurn(runtime_coordinator),
        list_pending_approvals=ListPendingApprovals(tool_execution_store),
        decide_approval=DecideApproval(tool_execution_store, approval_broker),
        list_tool_invocations=ListToolInvocations(tool_execution_store),
        model_configuration_service=model_configuration_service,
        runtime_coordinator=runtime_coordinator,
        conversation_store=conversation_store,
        tool_execution_store=tool_execution_store,
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
