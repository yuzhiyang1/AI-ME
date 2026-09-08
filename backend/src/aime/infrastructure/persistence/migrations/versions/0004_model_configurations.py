"""保存用户新增模型的非敏感元数据。"""

import sqlalchemy as sa
from alembic import op

revision = "0004_model_configurations"
down_revision = "0003_tool_execution_ledger"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增模型配置表；API Key 保存在系统凭据保险库，不进入该表。"""
    op.create_table(
        "model_configurations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("protocol", sa.String(length=32), nullable=False),
        sa.Column("base_url", sa.String(length=1000), nullable=True),
        sa.Column("context_window", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "model_id", name="uq_model_configuration_ref"),
    )


def downgrade() -> None:
    """删除模型配置元数据；系统凭据不由数据库迁移擅自删除。"""
    op.drop_table("model_configurations")
