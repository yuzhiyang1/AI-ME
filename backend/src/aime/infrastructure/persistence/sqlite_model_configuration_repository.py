"""本地模型非敏感元数据的 SQLite 仓储。"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.domain.model_configurations.entities import ModelConfiguration, ModelProtocol
from aime.infrastructure.persistence.sqlite_database import model_configurations_table


class SqliteModelConfigurationRepository:
    """仅持久化模型元数据；API Key 由系统凭据适配器保存。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def list_all(self) -> list[ModelConfiguration]:
        async with self._session_factory() as database_session:
            rows = (
                (
                    await database_session.execute(
                        select(model_configurations_table).order_by(
                            model_configurations_table.c.created_at
                        )
                    )
                )
                .mappings()
                .all()
            )
        return [_to_domain(row) for row in rows]

    async def get_by_ref(self, model_ref: str) -> ModelConfiguration | None:
        provider, separator, model_id = model_ref.partition("/")
        if not separator:
            return None
        async with self._session_factory() as database_session:
            row = (
                (
                    await database_session.execute(
                        select(model_configurations_table).where(
                            model_configurations_table.c.provider == provider,
                            model_configurations_table.c.model_id == model_id,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        return _to_domain(row) if row is not None else None

    async def save(self, configuration: ModelConfiguration) -> None:
        statement = insert(model_configurations_table).values(
            id=str(configuration.id),
            provider=configuration.provider,
            model_id=configuration.model_id,
            display_name=configuration.display_name,
            protocol=configuration.protocol.value,
            base_url=configuration.base_url,
            context_window=configuration.context_window,
            created_at=configuration.created_at,
            updated_at=configuration.updated_at,
        )
        statement = statement.on_conflict_do_update(
            index_elements=["provider", "model_id"],
            set_={
                "display_name": configuration.display_name,
                "protocol": configuration.protocol.value,
                "base_url": configuration.base_url,
                "context_window": configuration.context_window,
                "updated_at": configuration.updated_at,
            },
        )
        async with self._session_factory() as database_session:
            await database_session.execute(statement)
            await database_session.commit()


def _to_domain(row: RowMapping) -> ModelConfiguration:
    """将 SQLAlchemy 映射转换为不含技术依赖的领域实体。"""
    from uuid import UUID

    return ModelConfiguration(
        id=UUID(str(row["id"])),
        provider=str(row["provider"]),
        model_id=str(row["model_id"]),
        display_name=str(row["display_name"]),
        protocol=ModelProtocol(str(row["protocol"])),
        base_url=str(row["base_url"]) if row["base_url"] is not None else None,
        context_window=int(row["context_window"]),
        created_at=_as_utc(row["created_at"]),
        updated_at=_as_utc(row["updated_at"]),
    )


def _as_utc(value: datetime) -> datetime:
    """SQLite 会丢失时区标记，读取时恢复为 UTC。"""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
