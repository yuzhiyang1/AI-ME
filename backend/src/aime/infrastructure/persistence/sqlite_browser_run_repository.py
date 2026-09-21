"""浏览器运行与步骤的持久轨迹，数据库重启不自动续跑。"""

import json
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.domain.browser import BrowserRun, BrowserStatus
from aime.infrastructure.persistence.sqlite_database import browser_runs_table


def _decode(payload: str) -> BrowserRun:
    data = json.loads(payload)
    return BrowserRun(
        data["id"], data["sessionId"], data["goal"], BrowserStatus(data["status"]),
        data["steps"], data.get("pendingAction"), data.get("error"),
    )


class SqliteBrowserRunRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def save(self, run: BrowserRun) -> None:
        payload = json.dumps(run.to_dict(), ensure_ascii=False, allow_nan=False)
        statement = insert(browser_runs_table).values(
            id=run.id, session_id=run.session_id, payload=payload, created_at=datetime.now(UTC),
        ).on_conflict_do_update(index_elements=["id"], set_={"payload": payload})
        async with self._session_factory() as session:
            await session.execute(statement)
            await session.commit()

    async def current(self, session_id: str) -> BrowserRun | None:
        async with self._session_factory() as session:
            payload = (await session.execute(
                select(browser_runs_table.c.payload)
                .where(browser_runs_table.c.session_id == session_id)
                .order_by(browser_runs_table.c.created_at.desc()).limit(1)
            )).scalar_one_or_none()
        return _decode(payload) if payload is not None else None

    async def recover(self) -> None:
        async with self._session_factory() as session:
            payloads = (await session.execute(select(browser_runs_table.c.payload))).scalars().all()
        for payload in payloads:
            run = _decode(payload)
            if run.active:
                run.status = BrowserStatus.STOPPED
                run.pending_action = None
                run.error = "后端已重启，旧任务停止；已发送动作的结果需要人工核验"
                await self.save(run)
