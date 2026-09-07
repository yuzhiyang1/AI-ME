"""ProjectRepository 的 SQLite 实现。"""

import os
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import CursorResult, RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.domain.projects.entities import Project, ProjectRoot
from aime.domain.projects.repositories import (
    ProjectCreateResult,
    ProjectIdempotencyConflict,
    ProjectRepository,
)
from aime.infrastructure.persistence.sqlite_database import (
    project_idempotency_keys_table,
    project_roots_table,
    projects_table,
)


class SqliteProjectRepository(ProjectRepository):
    """在同一事务内保存 Project 主体、全部 roots 与创建幂等键。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create(
        self,
        project: Project,
        *,
        idempotency_key: str,
        request_hash: str,
    ) -> ProjectCreateResult:
        """创建 Project；并发命中同一幂等键时回读已经提交的结果。"""
        try:
            async with self._session_factory.begin() as database_session:
                existing = await _project_for_idempotency_key(database_session, idempotency_key)
                if existing is not None:
                    existing_hash, existing_project = existing
                    if existing_hash != request_hash:
                        raise ProjectIdempotencyConflict("重复请求与原项目内容不一致")
                    return ProjectCreateResult(existing_project, repeated=True)
                await _insert_project(database_session, project)
                await database_session.execute(
                    insert(project_idempotency_keys_table).values(
                        idempotency_key=idempotency_key,
                        project_id=str(project.id),
                        request_hash=request_hash,
                        created_at=project.created_at,
                    )
                )
        except IntegrityError:
            # 并发请求可能都先读到空值，唯一幂等键会让后提交者在这里回读赢家。
            async with self._session_factory() as database_session:
                existing = await _project_for_idempotency_key(database_session, idempotency_key)
            if existing is None or existing[0] != request_hash:
                raise ProjectIdempotencyConflict("重复请求与原项目内容不一致") from None
            return ProjectCreateResult(existing[1], repeated=True)
        return ProjectCreateResult(project, repeated=False)

    async def get(self, project_id: UUID) -> Project | None:
        """按 ID 读取 Project 及其有序 roots。"""
        async with self._session_factory() as database_session:
            row = (
                await database_session.execute(
                    select(projects_table).where(projects_table.c.id == str(project_id))
                )
            ).mappings().one_or_none()
            if row is None:
                return None
            roots = await _load_roots(database_session, [str(project_id)])
        return _to_domain(row, roots[str(project_id)])

    async def list_all(self) -> list[Project]:
        """用两次固定查询读取全部 Project，避免按项目逐条读取 roots。"""
        async with self._session_factory() as database_session:
            rows = (
                await database_session.execute(
                    select(projects_table).order_by(
                        projects_table.c.position,
                        projects_table.c.created_at,
                    )
                )
            ).mappings().all()
            roots = await _load_roots(database_session, [str(row["id"]) for row in rows])
        return [_to_domain(row, roots[str(row["id"])]) for row in rows]

    async def update(self, project: Project) -> bool:
        """原子更新 Project 并完整替换有序 roots。"""
        async with self._session_factory.begin() as database_session:
            result = cast(
                CursorResult[Any],
                await database_session.execute(
                    update(projects_table)
                    .where(projects_table.c.id == str(project.id))
                    .values(name=project.name, updated_at=project.updated_at)
                ),
            )
            if result.rowcount == 0:
                return False
            await database_session.execute(
                delete(project_roots_table).where(
                    project_roots_table.c.project_id == str(project.id)
                )
            )
            await _insert_roots(database_session, project)
        return True

    async def delete(self, project_id: UUID) -> bool:
        """删除项目；外键负责级联配置并把历史 Session 解除归属。"""
        async with self._session_factory.begin() as database_session:
            result = cast(
                CursorResult[Any],
                await database_session.execute(
                    delete(projects_table).where(projects_table.c.id == str(project_id))
                ),
            )
        return bool(result.rowcount > 0)


async def _insert_project(database_session: AsyncSession, project: Project) -> None:
    """在调用方事务中写入 Project 主体和 roots。"""
    await database_session.execute(
        insert(projects_table).values(
            id=str(project.id),
            name=project.name,
            position=project.position,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )
    )
    await _insert_roots(database_session, project)


async def _insert_roots(database_session: AsyncSession, project: Project) -> None:
    """批量保存已由应用层规范化的有序目录。"""
    await database_session.execute(
        insert(project_roots_table),
        [
            {
                "project_id": str(project.id),
                "position": root.position,
                "path": root.path,
                "path_key": os.path.normcase(root.path),
            }
            for root in project.roots
        ],
    )


async def _load_roots(
    database_session: AsyncSession,
    project_ids: list[str],
) -> dict[str, tuple[ProjectRoot, ...]]:
    """批量读取 roots，并保持数据库中明确的 position 顺序。"""
    grouped: defaultdict[str, list[ProjectRoot]] = defaultdict(list)
    if not project_ids:
        return {}
    rows = (
        await database_session.execute(
            select(project_roots_table)
            .where(project_roots_table.c.project_id.in_(project_ids))
            .order_by(project_roots_table.c.project_id, project_roots_table.c.position)
        )
    ).mappings()
    for row in rows:
        grouped[str(row["project_id"])].append(
            ProjectRoot(path=str(row["path"]), position=int(row["position"]))
        )
    return {project_id: tuple(roots) for project_id, roots in grouped.items()}


async def _project_for_idempotency_key(
    database_session: AsyncSession,
    idempotency_key: str,
) -> tuple[str, Project] | None:
    """读取幂等键对应的摘要与完整 Project。"""
    key_row = (
        await database_session.execute(
            select(project_idempotency_keys_table).where(
                project_idempotency_keys_table.c.idempotency_key == idempotency_key
            )
        )
    ).mappings().one_or_none()
    if key_row is None:
        return None
    project_row = (
        await database_session.execute(
            select(projects_table).where(projects_table.c.id == key_row["project_id"])
        )
    ).mappings().one()
    roots = await _load_roots(database_session, [str(key_row["project_id"])])
    return str(key_row["request_hash"]), _to_domain(
        project_row,
        roots[str(key_row["project_id"])],
    )


def _to_domain(row: RowMapping, roots: tuple[ProjectRoot, ...]) -> Project:
    """把 SQLAlchemy 行映射转换回纯领域对象。"""
    return Project(
        id=UUID(str(row["id"])),
        name=str(row["name"]),
        roots=roots,
        position=int(row["position"]),
        created_at=_as_utc(row["created_at"]),
        updated_at=_as_utc(row["updated_at"]),
    )


def _as_utc(value: datetime) -> datetime:
    """SQLite 会丢失时区标记，读取时恢复为 UTC。"""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
