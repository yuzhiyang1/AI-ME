"""独立 Jev 配置表，避免将浏览器策略模型暴露给普通 LLM 目录。"""

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.domain.browser import BrowserConfiguration
from aime.infrastructure.persistence.sqlite_database import browser_configuration_table


class SqliteBrowserConfigurationRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def get(self) -> BrowserConfiguration | None:
        async with self._session_factory() as session:
            result = await session.execute(select(browser_configuration_table))
            row = result.mappings().one_or_none()
        if row is None:
            return None
        return BrowserConfiguration(str(row["model"]), row["credential_id"])

    async def save(self, configuration: BrowserConfiguration) -> None:
        statement = insert(browser_configuration_table).values(
            id=1, model=configuration.model, credential_id=configuration.credential_id,
        )
        statement = statement.on_conflict_do_update(
            index_elements=["id"], set_={
                "model": configuration.model, "credential_id": configuration.credential_id,
            },
        )
        async with self._session_factory() as session:
            await session.execute(statement)
            await session.commit()
