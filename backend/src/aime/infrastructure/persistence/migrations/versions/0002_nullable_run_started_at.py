"""允许排队中的 AgentRun 尚未开始计时。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_nullable_run_started_at"
down_revision: str | None = "0001_agent_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """用 SQLite batch 重建表，把 started_at 调整为可空。"""
    with op.batch_alter_table("agent_runs") as batch_op:
        batch_op.alter_column(
            "started_at",
            existing_type=sa.DateTime(timezone=True),
            nullable=True,
        )


def downgrade() -> None:
    """仅在不存在排队 Run 时允许回退为非空字段。"""
    with op.batch_alter_table("agent_runs") as batch_op:
        batch_op.alter_column(
            "started_at",
            existing_type=sa.DateTime(timezone=True),
            nullable=False,
        )
