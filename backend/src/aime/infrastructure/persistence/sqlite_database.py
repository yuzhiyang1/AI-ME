"""AI-ME 本地 SQLite 数据库与表定义。"""

from pathlib import Path
from typing import Any

from anyio import to_thread
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from aime.infrastructure.persistence.migration_runner import upgrade_database

metadata = MetaData()

sessions_table = Table(
    "agent_sessions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("title", String(120), nullable=False),
    Column("workspace_path", String, nullable=False),
    Column("default_model", String(200), nullable=False),
    Column("permission_profile", String(32), nullable=False),
    Column("lifecycle", String(32), nullable=False),
    Column("activity", String(32), nullable=False),
    Column("pinned", Boolean, nullable=False, default=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("last_event_sequence", Integer, nullable=False, default=0),
)

turns_table = Table(
    "agent_turns",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("status", String(32), nullable=False),
    Column("client_request_id", String(120), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("finished_at", DateTime(timezone=True)),
    UniqueConstraint("session_id", "client_request_id", name="uq_turn_client_request"),
)

Index(
    "uq_active_turn_per_session",
    turns_table.c.session_id,
    unique=True,
    sqlite_where=turns_table.c.status.in_(["queued", "in_progress", "waiting_for_user"]),
)

agent_runs_table = Table(
    "agent_runs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("turn_id", ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False),
    Column("attempt", Integer, nullable=False),
    Column("status", String(32), nullable=False),
    Column("model_ref", String(200), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("finished_at", DateTime(timezone=True)),
    Column("terminal_event_id", String(36)),
    UniqueConstraint("turn_id", "attempt", name="uq_run_turn_attempt"),
)

runtime_events_table = Table(
    "runtime_events",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("turn_id", ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False),
    Column("run_id", ForeignKey("agent_runs.id", ondelete="CASCADE")),
    Column("sequence", Integer, nullable=False),
    Column("type", String(64), nullable=False),
    Column("payload_json", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("session_id", "sequence", name="uq_runtime_event_sequence"),
)

session_items_table = Table(
    "session_items",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("turn_id", ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False),
    Column("run_id", ForeignKey("agent_runs.id", ondelete="CASCADE")),
    Column("sequence", Integer, nullable=False),
    Column("type", String(64), nullable=False),
    Column("status", String(32), nullable=False),
    Column("content_json", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("session_id", "sequence", name="uq_session_item_sequence"),
)

tool_invocations_table = Table(
    "tool_invocations",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("turn_id", ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False),
    Column("run_id", ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False),
    Column("call_id", String(200), nullable=False),
    Column("step_index", Integer, nullable=False),
    Column("call_index", Integer, nullable=False),
    Column("tool_name", String(128), nullable=False),
    Column("arguments_json", Text, nullable=False),
    Column("assistant_text", Text, nullable=False, default=""),
    Column("execution_semantics", String(32), nullable=False),
    Column("risk_level", String(32), nullable=False),
    Column("status", String(32), nullable=False),
    Column("result_json", Text),
    Column("is_error", Boolean),
    Column("prepared_at", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("finished_at", DateTime(timezone=True)),
    UniqueConstraint("run_id", "call_id", name="uq_tool_invocation_run_call"),
    UniqueConstraint("run_id", "step_index", "call_index", name="uq_tool_invocation_run_position"),
)

approval_requests_table = Table(
    "approval_requests",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("turn_id", ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False),
    Column("run_id", ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False),
    Column(
        "invocation_id",
        ForeignKey("tool_invocations.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    ),
    Column("reason", Text, nullable=False),
    Column("status", String(32), nullable=False),
    Column("decision", String(32)),
    Column("requested_at", DateTime(timezone=True), nullable=False),
    Column("resolved_at", DateTime(timezone=True)),
)

approval_grants_table = Table(
    "approval_grants",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("session_id", ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
    Column("tool_name", String(128), nullable=False),
    Column(
        "approval_id",
        ForeignKey("approval_requests.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("session_id", "tool_name", name="uq_approval_grant_session_tool"),
)


class SqliteDatabase:
    """拥有异步 SQLite engine，并统一管理初始化与关闭。"""

    def __init__(self, state_dir: Path) -> None:
        self._state_dir = state_dir
        self._database_path = state_dir / "ai-me.db"
        self.engine: AsyncEngine = create_async_engine(
            f"sqlite+aiosqlite:///{self._database_path.as_posix()}",
        )
        event.listen(self.engine.sync_engine, "connect", _configure_sqlite_connection)
        self.session_factory = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )

    async def initialize(self) -> None:
        """创建状态目录，并把状态库迁移到当前版本。"""
        await to_thread.run_sync(_prepare_database, self._state_dir, self._database_path)

    async def close(self) -> None:
        """释放数据库连接池。"""
        await self.engine.dispose()


def _prepare_database(state_dir: Path, database_path: Path) -> None:
    """在线程中执行目录创建和同步 Alembic 迁移。"""
    state_dir.mkdir(parents=True, exist_ok=True)
    upgrade_database(database_path)


def _configure_sqlite_connection(dbapi_connection: Any, _: Any) -> None:
    """为池中的每条 SQLite 连接启用完整性与并发相关设置。"""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
