"""应用装配根。所有具体实现只在这里接线。"""

import os
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from aime.application.approvals.services import DecideApproval, ListPendingApprovals
from aime.application.browser_configuration import BrowserConfigurationService
from aime.application.browser_service import BrowserService
from aime.application.model_configurations.services import ModelConfigurationService
from aime.application.models.services import ListAvailableModels, StreamModelCompletion
from aime.application.ports.browser import BrowserPlanner
from aime.application.ports.conversation_store import ConversationStore
from aime.application.ports.model_configuration import ModelCredentialStore
from aime.application.ports.model_gateway import ModelGateway
from aime.application.ports.tool_execution import ToolRegistry
from aime.application.ports.tool_execution_store import ToolExecutionStore
from aime.application.projects.services import (
    CreateProject,
    DeleteProject,
    GetProject,
    ListProjects,
    UpdateProject,
)
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
from aime.application.skill_service import SkillService
from aime.application.tools.services import ListToolInvocations
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.infrastructure.browser_bridge import DesktopBrowserBridge
from aime.infrastructure.browser_models import GatewayBrowserTextGenerator, TypeSafeBrowserPlanner
from aime.infrastructure.credentials.system_keyring import SystemModelCredentialStore
from aime.infrastructure.llm.configurable_gateway import ConfigurableModelGateway
from aime.infrastructure.llm.model_gateway_impl import build_gateway_from_env
from aime.infrastructure.llm.token_counter import ConservativeTokenCounter
from aime.infrastructure.persistence.in_memory_work_item_repository import (
    InMemoryWorkItemRepository,
)
from aime.infrastructure.persistence.local_artifact_store import LocalArtifactStore
from aime.infrastructure.persistence.sqlite_browser_configuration_repository import (
    SqliteBrowserConfigurationRepository,
)
from aime.infrastructure.persistence.sqlite_browser_run_repository import SqliteBrowserRunRepository
from aime.infrastructure.persistence.sqlite_context_store import SqliteContextStore
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_model_configuration_repository import (
    SqliteModelConfigurationRepository,
)
from aime.infrastructure.persistence.sqlite_project_repository import SqliteProjectRepository
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository
from aime.infrastructure.persistence.sqlite_skill_store import SqliteSkillStore
from aime.infrastructure.persistence.sqlite_tool_execution_store import SqliteToolExecutionStore
from aime.infrastructure.runtime.approval_broker import InMemoryApprovalBroker
from aime.infrastructure.runtime.model_agent_runtime import ModelAgentRuntime
from aime.infrastructure.skills import LocalSkillResources
from aime.infrastructure.tools.browser_tools import BrowserToolRegistry
from aime.infrastructure.tools.builtin import BuiltInToolRegistry


@dataclass(slots=True)
class Container:
    """模块化单体的依赖容器。"""

    create_work_item: CreateWorkItem
    skill_service: SkillService
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
    create_project: CreateProject
    list_projects: ListProjects
    get_project: GetProject
    update_project: UpdateProject
    delete_project: DeleteProject
    runtime_coordinator: RuntimeCoordinator
    conversation_store: ConversationStore
    tool_execution_store: ToolExecutionStore
    database: SqliteDatabase
    browser_service: BrowserService
    browser_bridge: DesktopBrowserBridge
    browser_http_client: httpx.AsyncClient
    browser_bridge_token: str = field(repr=False)

    async def initialize(self) -> None:
        """初始化需要进程生命周期管理的基础设施。"""
        await self.database.initialize()
        await self.model_configuration_service.initialize()
        await self.browser_service.initialize()
        await self.tool_execution_store.recover_unsettled_invocations()
        await self.conversation_store.recover_incomplete_runs()
        for execution in await self.conversation_store.list_resumable_executions():
            self.runtime_coordinator.resume(execution)

    async def close(self) -> None:
        """按装配根拥有的顺序关闭基础设施。"""
        try:
            await self.browser_service.close()
            await self.runtime_coordinator.close()
        finally:
            await self.browser_http_client.aclose()
            await self.database.close()


def build_container(
    *,
    state_dir: Path | None = None,
    model_gateway: ModelGateway | None = None,
    model_credential_store: ModelCredentialStore | None = None,
    tool_registry: ToolRegistry | None = None,
    browser_planner: BrowserPlanner | None = None,
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
    browser_bridge = DesktopBrowserBridge()
    browser_http_client = httpx.AsyncClient(timeout=30, follow_redirects=False)
    resolved_browser_planner = browser_planner or TypeSafeBrowserPlanner(browser_http_client, "")
    browser_configuration = BrowserConfigurationService(
        SqliteBrowserConfigurationRepository(database.session_factory),
        credential_store, resolved_browser_planner,
        fallback_key=os.environ.get("TYPESAFE_API_KEY", ""),
        fallback_model=os.environ.get("TYPESAFE_MODEL", "jev-latest"),
    )
    browser_service = BrowserService(
        GetSession(sessions), browser_bridge, resolved_browser_planner,
        GatewayBrowserTextGenerator(resolved_model_gateway), browser_configuration,
        SqliteBrowserRunRepository(database.session_factory),
    )
    projects = SqliteProjectRepository(database.session_factory)
    conversation_store = SqliteConversationStore(database.session_factory)
    tool_execution_store = SqliteToolExecutionStore(database.session_factory)
    approval_broker = InMemoryApprovalBroker()
    context_store = SqliteContextStore(database.session_factory)
    personal_roots = tuple(Path(p).expanduser().resolve() for p in
                           os.environ.get("AIME_SKILL_ROOTS", str(Path.home() / ".agents/skills"))
                           .split(os.pathsep) if p.strip())
    skill_service = SkillService(LocalSkillResources(personal_roots),
                                 SqliteSkillStore(database.session_factory))
    artifact_store = LocalArtifactStore(resolved_state_dir / "artifacts")
    agent_runtime = ModelAgentRuntime(
        resolved_model_gateway,
        tool_execution_store,
        approval_broker,
        tool_registry or BrowserToolRegistry(BuiltInToolRegistry(artifact_store), browser_bridge),
        context_store=context_store,
        artifact_store=artifact_store,
        token_counter=ConservativeTokenCounter(),
        skill_service=skill_service,
    )
    runtime_coordinator = RuntimeCoordinator(
        agent_runtime,
        conversation_store,
        tool_store=tool_execution_store,
    )
    return Container(
        create_work_item=CreateWorkItem(work_items),
        skill_service=skill_service,
        list_work_items=ListWorkItems(work_items),
        list_available_models=ListAvailableModels(resolved_model_gateway),
        stream_model_completion=StreamModelCompletion(resolved_model_gateway),
        create_session=CreateSession(sessions, projects),
        get_session=GetSession(sessions),
        list_sessions=ListSessions(sessions, conversation_store),
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
        create_project=CreateProject(projects),
        list_projects=ListProjects(projects),
        get_project=GetProject(projects),
        update_project=UpdateProject(projects),
        delete_project=DeleteProject(projects),
        runtime_coordinator=runtime_coordinator,
        conversation_store=conversation_store,
        tool_execution_store=tool_execution_store,
        database=database,
        browser_service=browser_service,
        browser_bridge=browser_bridge,
        browser_http_client=browser_http_client,
        browser_bridge_token=os.environ.get("AIME_BROWSER_BRIDGE_TOKEN", ""),
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
