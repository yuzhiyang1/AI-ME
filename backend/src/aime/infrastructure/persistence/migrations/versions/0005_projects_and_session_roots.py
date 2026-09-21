"""增加 Project、项目目录和 Session 运行目录快照。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_projects_and_session_roots"
down_revision: str | None = "0004_model_configurations"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """创建 Project 表，并把已有会话回填成单目录独立任务。"""
    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "project_roots",
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("path_key", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id", "position", name="pk_project_roots"),
        sa.UniqueConstraint("project_id", "path_key", name="uq_project_root_path_key"),
    )
    op.create_table(
        "project_idempotency_keys",
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("idempotency_key"),
    )

    with op.batch_alter_table("agent_sessions") as batch_op:
        batch_op.add_column(sa.Column("project_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_agent_sessions_project_id",
            "projects",
            ["project_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            "ix_agent_sessions_project_updated",
            ["project_id", "updated_at"],
            unique=False,
        )

    op.create_table(
        "session_workspace_roots",
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("path_key", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["agent_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id", "position", name="pk_session_workspace_roots"),
        sa.UniqueConstraint(
            "session_id",
            "path_key",
            name="uq_session_workspace_root_path_key",
        ),
    )
    op.execute(
        "INSERT INTO session_workspace_roots (session_id, position, path, path_key) "
        "SELECT id, 0, workspace_path, lower(workspace_path) FROM agent_sessions"
    )


def downgrade() -> None:
    """移除项目配置和会话目录快照，但保留历史会话主体。"""
    op.drop_table("session_workspace_roots")
    with op.batch_alter_table("agent_sessions") as batch_op:
        batch_op.drop_index("ix_agent_sessions_project_updated")
        batch_op.drop_constraint("fk_agent_sessions_project_id", type_="foreignkey")
        batch_op.drop_column("project_id")
    op.drop_table("project_idempotency_keys")
    op.drop_table("project_roots")
    op.drop_table("projects")
