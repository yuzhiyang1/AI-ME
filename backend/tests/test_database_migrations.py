"""验证本地状态库由可演进的迁移版本管理。"""

import sqlite3
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy.ext.asyncio import create_async_engine

from aime.application.sessions.commands import CreateSessionCommand
from aime.application.sessions.services import CreateSession
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.persistence.migration_runner import _alembic_config
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase, metadata
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository


async def test_fresh_database_is_upgraded_to_a_versioned_schema(tmp_path: Path) -> None:
    """新数据库必须记录 Alembic 版本，不能只依赖运行时 create_all。"""
    state_dir = tmp_path / "state"
    database = SqliteDatabase(state_dir)
    await database.initialize()
    await database.close()

    with sqlite3.connect(state_dir / "ai-me.db") as connection:
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        table_names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }

    assert version == ("0004_model_configurations",)
    assert {
        "agent_sessions",
        "agent_turns",
        "agent_runs",
        "runtime_events",
        "session_items",
        "tool_invocations",
        "approval_requests",
        "approval_grants",
        "model_configurations",
    }.issubset(table_names)


async def test_unversioned_preview_database_is_adopted_only_after_schema_validation(
    tmp_path: Path,
) -> None:
    """早期预览库结构完整时可以纳入 Alembic，且必须补上活跃 Turn 唯一索引。"""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    database_path = state_dir / "ai-me.db"
    preview_engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    async with preview_engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    await preview_engine.dispose()
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP INDEX uq_active_turn_per_session")

    database = SqliteDatabase(state_dir)
    await database.initialize()
    await database.close()

    with sqlite3.connect(database_path) as connection:
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        active_index = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' "
            "AND name = 'uq_active_turn_per_session'"
        ).fetchone()

    assert version == ("0004_model_configurations",)
    assert active_index == ("uq_active_turn_per_session",)


async def test_existing_0001_database_is_upgraded_before_creating_a_queued_run(
    tmp_path: Path,
) -> None:
    """真实执行过 0001 的本地库升级后，必须允许 queued Run 的空开始时间。"""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    database_path = state_dir / "ai-me.db"
    command.upgrade(_alembic_config(database_path), "0001_agent_sessions")
    with sqlite3.connect(database_path) as connection:
        old_started_at = next(
            row
            for row in connection.execute("PRAGMA table_info('agent_runs')")
            if row[1] == "started_at"
        )
    assert old_started_at[3] == 1

    database = SqliteDatabase(state_dir)
    await database.initialize()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = await CreateSession(SqliteSessionRepository(database.session_factory)).execute(
        CreateSessionCommand(
            workspace_path=str(workspace),
            default_model="openai/gpt-5",
            permission_profile=PermissionProfile.WORKSPACE_WRITE,
        )
    )
    execution = await SqliteConversationStore(database.session_factory).start_turn(
        session_id=session.id.value,
        instruction="验证旧库升级",
        client_request_id="old-schema-upgrade",
    )
    await database.close()

    with sqlite3.connect(database_path) as connection:
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        upgraded_started_at = next(
            row
            for row in connection.execute("PRAGMA table_info('agent_runs')")
            if row[1] == "started_at"
        )

    assert version == ("0004_model_configurations",)
    assert upgraded_started_at[3] == 0
    assert execution.run.status.value == "created"
    assert execution.run.started_at is None


async def test_unversioned_preview_database_without_constraints_is_rejected(
    tmp_path: Path,
) -> None:
    """表名和字段看似完整但缺少外键/唯一约束时，不能被误认成合法预览库。"""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    database_path = state_dir / "ai-me.db"
    preview_engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    async with preview_engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    await preview_engine.dispose()
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TABLE runtime_events")
        connection.execute(
            "CREATE TABLE runtime_events ("
            "id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL, "
            "turn_id VARCHAR(36) NOT NULL, run_id VARCHAR(36), sequence INTEGER NOT NULL, "
            "type VARCHAR(64) NOT NULL, payload_json TEXT NOT NULL, created_at DATETIME NOT NULL)"
        )

    database = SqliteDatabase(state_dir)
    with pytest.raises(RuntimeError, match="定义不匹配|外键|唯一约束"):
        await database.initialize()
    await database.close()


async def test_unversioned_preview_database_with_wrong_active_index_is_rejected(
    tmp_path: Path,
) -> None:
    """同名索引不能掩盖非唯一或缺少活跃状态谓词的错误定义。"""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    database_path = state_dir / "ai-me.db"
    preview_engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    async with preview_engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    await preview_engine.dispose()
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP INDEX uq_active_turn_per_session")
        connection.execute("CREATE INDEX uq_active_turn_per_session ON agent_turns (session_id)")

    database = SqliteDatabase(state_dir)
    with pytest.raises(RuntimeError, match="活跃 Turn 唯一索引"):
        await database.initialize()
    await database.close()


async def test_unversioned_preview_database_with_orphan_rows_is_rejected(
    tmp_path: Path,
) -> None:
    """预览阶段曾关闭外键产生的孤儿数据，不能被迁移盖章为有效状态。"""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    database_path = state_dir / "ai-me.db"
    preview_engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    async with preview_engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    await preview_engine.dispose()
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "INSERT INTO agent_turns "
            "(id, session_id, status, client_request_id, created_at) "
            "VALUES ('orphan-turn', 'missing-session', 'queued', "
            "'orphan-request', CURRENT_TIMESTAMP)"
        )

    database = SqliteDatabase(state_dir)
    with pytest.raises(RuntimeError, match="外键违规数据"):
        await database.initialize()
    await database.close()
