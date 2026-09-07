"""Agent Session 应用服务。"""

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from anyio import to_thread

from aime.application.ports.conversation_store import (
    ConversationStore,
    SessionContextUsageSummary,
)
from aime.application.projects.services import ProjectNotFound
from aime.application.sessions.commands import CreateSessionCommand
from aime.domain.projects.repositories import ProjectRepository
from aime.domain.sessions.entities import AgentSession
from aime.domain.sessions.repositories import SessionRepository
from aime.domain.sessions.value_objects import SessionId


class SessionNotFound(LookupError):
    """请求的 Session 不存在。"""


@dataclass(frozen=True, slots=True)
class SessionListItem:
    """会话主体及其侧栏上下文圆环读取投影。"""

    session: AgentSession
    context_usage: SessionContextUsageSummary


class CreateSession:
    """校验工作区并创建持久 Session。"""

    def __init__(
        self,
        repository: SessionRepository,
        project_repository: ProjectRepository | None = None,
    ) -> None:
        self._repository = repository
        self._project_repository = project_repository

    async def execute(self, command: CreateSessionCommand) -> AgentSession:
        """创建 Session；工作区必须是已经存在的目录。"""
        if command.project_id is not None and command.workspace_path is not None:
            raise ValueError("项目会话不能覆盖项目目录")
        if command.project_id is None and command.workspace_path is None:
            raise ValueError("独立会话必须选择工作目录")
        if command.project_id is not None:
            if self._project_repository is None:
                raise RuntimeError("项目会话创建缺少 ProjectRepository")
            project = await self._project_repository.get(command.project_id)
            if project is None:
                raise ProjectNotFound("项目不存在或已删除")
            workspace_roots = tuple(root.path for root in project.roots)
            workspace_path = workspace_roots[0]
        else:
            assert command.workspace_path is not None
            workspace = await to_thread.run_sync(_resolve_workspace, command.workspace_path)
            if not workspace.is_dir():
                raise ValueError("Session 工作区必须是已经存在的目录")
            workspace_path = str(workspace)
            workspace_roots = (workspace_path,)
        default_model = command.default_model.strip()
        if not default_model:
            raise ValueError("Session 默认模型不能为空")
        session = AgentSession.create(
            project_id=command.project_id,
            workspace_path=workspace_path,
            workspace_roots=workspace_roots,
            default_model=default_model,
            permission_profile=command.permission_profile,
        )
        await self._repository.add(session)
        return session


def _resolve_workspace(workspace_path: str) -> Path:
    """在线程中解析本地路径，避免阻塞异步请求循环。"""
    return Path(workspace_path).expanduser().resolve(strict=True)


class GetSession:
    """读取一条持久 Session。"""

    def __init__(self, repository: SessionRepository) -> None:
        self._repository = repository

    async def execute(self, session_id: UUID) -> AgentSession:
        """按 ID 返回 Session，不存在时抛出稳定应用异常。"""
        session = await self._repository.get(SessionId(session_id))
        if session is None:
            raise SessionNotFound(f"Session 不存在：{session_id}")
        return session


class ListSessions:
    """按最近活动时间列出所有持久 Session。"""

    def __init__(
        self,
        repository: SessionRepository,
        conversation_store: ConversationStore,
    ) -> None:
        self._repository = repository
        self._conversation_store = conversation_store

    async def execute(self) -> list[SessionListItem]:
        """一次批量读取会话和上下文摘要，不产生逐会话 usage 请求。"""
        sessions = await self._repository.list_all()
        summaries = await self._conversation_store.list_context_usage_summaries()
        unknown = SessionContextUsageSummary(None, None, None, partial=True)
        return [
            SessionListItem(session, summaries.get(session.id.value, unknown))
            for session in sessions
        ]
