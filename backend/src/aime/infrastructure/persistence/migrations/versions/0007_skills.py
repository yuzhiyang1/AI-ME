"""Skill 偏好与不可变运行快照。"""

import sqlalchemy as sa
from alembic import op

revision = "0007_skills"
down_revision = "0006_context_windows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """所有正文与目录快照保留在现有本地数据库。"""
    op.create_table(
        "skill_state",
        sa.Column("key", sa.String, primary_key=True),
        sa.Column("value", sa.Text, nullable=False),
    )


def downgrade() -> None:
    """回滚仅移除 Skill 内部状态，不删除用户源文件。"""
    op.drop_table("skill_state")
