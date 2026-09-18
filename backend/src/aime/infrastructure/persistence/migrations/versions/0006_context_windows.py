"""本地窗口、历史、Checkpoint 和持久请求预算。

Revision ID: 0006_context_windows
Revises: 0005_projects_and_session_roots
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_context_windows"
down_revision = "0005_projects_and_session_roots"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "context_windows",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("agent_sessions.id"), nullable=False),
        sa.Column("number", sa.Integer, nullable=False),
        sa.Column("through_sequence", sa.Integer, nullable=False),
        sa.Column("baseline_json", sa.Text, nullable=False),
        sa.Column("active", sa.Boolean, nullable=False),
        sa.Column("rollover_id", sa.String(200), unique=True, nullable=False),
        sa.Column("reason", sa.String(64), nullable=False),
        sa.UniqueConstraint("session_id", "number"),
    )
    op.create_index(
        "uq_context_active",
        "context_windows",
        ["session_id"],
        unique=True,
        sqlite_where=sa.text("active = 1"),
    )
    op.create_table(
        "history_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("agent_sessions.id"), nullable=False),
        sa.Column("window_id", sa.String(36), sa.ForeignKey("context_windows.id"), nullable=False),
        sa.Column("source_key", sa.String(200), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("tool", sa.String(128), nullable=False),
        sa.Column("message_json", sa.Text, nullable=False),
        sa.UniqueConstraint("session_id", "source_key"),
    )
    op.create_index("ix_history_session_id", "history_items", ["session_id", "id"])
    op.create_table(
        "context_checkpoints",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("agent_sessions.id"), nullable=False),
        sa.Column(
            "source_window_id", sa.String(36), sa.ForeignKey("context_windows.id"), nullable=False
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("covered_sequence", sa.Integer, nullable=False),
        sa.Column("content_json", sa.Text, nullable=False),
        sa.Column("operation_id", sa.String(200), nullable=False, unique=True),
        sa.UniqueConstraint("session_id", "version"),
    )
    op.create_table(
        "context_runs",
        sa.Column("run_id", sa.String(36), sa.ForeignKey("agent_runs.id"), primary_key=True),
        sa.Column("completed_step", sa.Integer, nullable=False),
        sa.Column("request_count", sa.Integer, nullable=False),
        sa.Column("overflow_step", sa.Integer),
        sa.Column("failure_signature", sa.Text),
        sa.Column("failure_count", sa.Integer, nullable=False),
        sa.Column("maintenance_window", sa.String(36)),
        sa.Column("finished", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("pending_json", sa.Text),
    )


def downgrade() -> None:
    for table in ("context_runs", "context_checkpoints", "history_items", "context_windows"):
        op.drop_table(table)
