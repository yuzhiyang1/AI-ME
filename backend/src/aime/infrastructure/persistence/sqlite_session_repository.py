"""SessionRepository 的 SQLite 实现。"""

import os
from collections import defaultdict
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
from aime.infrastructure.persistence.sqlite_database import (
    session_workspace_roots_table,
    sessions_table,
)


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
                    project_id=str(session.project_id) if session.project_id is not None else None,
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
            await database_session.execute(
                insert(session_workspace_roots_table),
                [
                    {
                        "session_id": str(session.id.value),
                        "position": position,
                        "path": path,
                        "path_key": os.path.normcase(path),
                    }
                    for position, path in enumerate(session.workspace_roots)
                ],
            )

    async def get(self, session_id: SessionId) -> AgentSession | None:
        """按稳定 ID 读取 Session。"""
        async with self._session_factory() as database_session:
            row = (
                await database_session.execute(
                    select(sessions_table).where(sessions_table.c.id == str(session_id.value))
                )
            ).mappings().one_or_none()
            roots = await _load_roots(database_session, [str(session_id.value)])
        return _to_domain(row, roots[str(session_id.value)]) if row is not None else None

    async def list_all(self) -> list[AgentSession]:
        """按最近更新时间列出 Session。"""
        async with self._session_factory() as database_session:
            rows = (
                await database_session.execute(
                    select(sessions_table).order_by(sessions_table.c.updated_at.desc())
                )
            ).mappings().all()
            roots = await _load_roots(database_session, [str(row["id"]) for row in rows])
            return [_to_domain(row, roots[str(row["id"])]) for row in rows]


async def _load_roots(
    database_session: AsyncSession,
    session_ids: list[str],
) -> dict[str, tuple[str, ...]]:
    """批量读取 Session 的有序运行目录快照。"""
    grouped: defaultdict[str, list[str]] = defaultdict(list)
    if not session_ids:
        return {}
    rows = (
        await database_session.execute(
            select(session_workspace_roots_table)
            .where(session_workspace_roots_table.c.session_id.in_(session_ids))
            .order_by(
                session_workspace_roots_table.c.session_id,
                session_workspace_roots_table.c.position,
            )
        )
    ).mappings()
    for row in rows:
        grouped[str(row["session_id"])].append(str(row["path"]))
    return {session_id: tuple(paths) for session_id, paths in grouped.items()}


def _to_domain(row: RowMapping, workspace_roots: tuple[str, ...]) -> AgentSession:
    """把 SQLAlchemy 行映射转换回纯领域对象。"""
    return AgentSession(
        id=SessionId(UUID(row["id"])),
        title=SessionTitle(row["title"]),
        project_id=UUID(str(row["project_id"])) if row["project_id"] is not None else None,
        workspace_path=row["workspace_path"],
        workspace_roots=workspace_roots,
        default_model=row["default_model"],
        permission_profile=PermissionProfile(row["permission_profile"]),
        lifecycle=SessionLifecycle(row["lifecycle"]),
        activity=SessionActivity(row["activity"]),
        pinned=row["pinned"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
