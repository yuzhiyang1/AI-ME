"""当前上下文表定义，用于 schema 检查；历史迁移仍保持独立、不可变。"""

from sqlalchemy import (
    Boolean,
    Column,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    false,
    text,
)


def register_context_tables(metadata: MetaData) -> None:
    """把上下文表纳入现有元数据，避免后续 autogenerate 误判为应删除的表。"""
    windows = Table(
        "context_windows",
        metadata,
        Column("id", String(36), primary_key=True),
        Column("session_id", ForeignKey("agent_sessions.id"), nullable=False),
        Column("number", Integer, nullable=False),
        Column("through_sequence", Integer, nullable=False),
        Column("baseline_json", Text, nullable=False),
        Column("active", Boolean, nullable=False),
        Column("rollover_id", String(200), unique=True, nullable=False),
        Column("reason", String(64), nullable=False),
        UniqueConstraint("session_id", "number"),
    )
    Index("uq_context_active", windows.c.session_id, unique=True, sqlite_where=text("active = 1"))
    history = Table(
        "history_items",
        metadata,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("session_id", ForeignKey("agent_sessions.id"), nullable=False),
        Column("window_id", ForeignKey("context_windows.id"), nullable=False),
        Column("source_key", String(200), nullable=False),
        Column("role", String(32), nullable=False),
        Column("tool", String(128), nullable=False),
        Column("message_json", Text, nullable=False),
        UniqueConstraint("session_id", "source_key"),
    )
    Index("ix_history_session_id", history.c.session_id, history.c.id)
    Table(
        "context_checkpoints",
        metadata,
        Column("id", String(36), primary_key=True),
        Column("session_id", ForeignKey("agent_sessions.id"), nullable=False),
        Column("source_window_id", ForeignKey("context_windows.id"), nullable=False),
        Column("version", Integer, nullable=False),
        Column("covered_sequence", Integer, nullable=False),
        Column("content_json", Text, nullable=False),
        Column("operation_id", String(200), unique=True, nullable=False),
        UniqueConstraint("session_id", "version"),
    )
    Table(
        "context_runs",
        metadata,
        Column("run_id", ForeignKey("agent_runs.id"), primary_key=True),
        Column("completed_step", Integer, nullable=False),
        Column("request_count", Integer, nullable=False),
        Column("overflow_step", Integer),
        Column("failure_signature", Text),
        Column("failure_count", Integer, nullable=False),
        Column("maintenance_window", String(36)),
        Column("finished", Boolean, nullable=False, server_default=false()),
        Column("pending_json", Text),
    )
