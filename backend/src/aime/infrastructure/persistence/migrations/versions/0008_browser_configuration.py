"""浏览器策略模型独立配置；不存 API Key，也不加入普通模型目录。"""

import sqlalchemy as sa
from alembic import op

revision = "0008_browser_configuration"
down_revision = "0007_skills"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "browser_configuration",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("credential_id", sa.String(80), nullable=True),
    )
    op.create_table(
        "browser_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("payload", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_browser_runs_session_id", "browser_runs", ["session_id"])


def downgrade() -> None:
    op.drop_table("browser_runs")
    op.drop_table("browser_configuration")
