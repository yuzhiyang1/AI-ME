"""SessionRepository 的 SQLite 实现。"""

from uuid import UUID

from sqlalchemy import insert, select
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.domain.sessions.entities import AgentSession
from aime.domain.sessions.repositories import SessionRepository
from aime.domain.sessions.value_objects import (
    PermissionProfile,
    SessionActivity,
    SessionId,
    SessionLifecycle,
    SessionTitle,
)
from aime.infrastructure.persistence.sqlite_database import sessions_table


class SqliteSessionRepository(SessionRepository):
    """把 Session 映射到本地 SQLite 表。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def add(self, session: AgentSession) -> None:
        """在独立事务中新增 Session。"""
        async with self._session_factory.begin() as database_session:
            await database_session.execute(
                insert(sessions_table).values(
                    id=str(session.id.value),
                    title=session.title.value,
                    workspace_path=session.workspace_path,
                    default_model=session.default_model,
                    permission_profile=session.permission_profile.value,
                    lifecycle=session.lifecycle.value,
                    activity=session.activity.value,
                    pinned=session.pinned,
                    created_at=session.created_at,
                    updated_at=session.updated_at,
                    last_event_sequence=0,
                )
            )

    async def get(self, session_id: SessionId) -> AgentSession | None:
        """按稳定 ID 读取 Session。"""
        async with self._session_factory() as database_session:
            row = (
                await database_session.execute(
                    select(sessions_table).where(sessions_table.c.id == str(session_id.value))
                )
            ).mappings().one_or_none()
        return _to_domain(row) if row is not None else None

    async def list_all(self) -> list[AgentSession]:
        """按最近更新时间列出 Session。"""
        async with self._session_factory() as database_session:
            rows = (
                await database_session.execute(
                    select(sessions_table).order_by(sessions_table.c.updated_at.desc())
                )
            ).mappings()
            return [_to_domain(row) for row in rows]


def _to_domain(row: RowMapping) -> AgentSession:
    """把 SQLAlchemy 行映射转换回纯领域对象。"""
    return AgentSession(
        id=SessionId(UUID(row["id"])),
        title=SessionTitle(row["title"]),
        workspace_path=row["workspace_path"],
        default_model=row["default_model"],
        permission_profile=PermissionProfile(row["permission_profile"]),
        lifecycle=SessionLifecycle(row["lifecycle"]),
        activity=SessionActivity(row["activity"]),
        pinned=row["pinned"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
