"""Skill 偏好、目录与正文快照复用应用 SQLite。"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


class SqliteSkillStore:
    """快照键包含 Session/Run，重启不改变已经读取的版本。"""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def get(self, key: str) -> str | None:
        async with self._sessions() as db:
            return (
                await db.execute(text("SELECT value FROM skill_state WHERE key=:key"), {"key": key})
            ).scalar_one_or_none()

    async def preferences(self) -> dict[str, str]:
        """一次读取偏好，避免 1000 个 Skill 引起 1000 次数据库查询。"""
        async with self._sessions() as db:
            rows = await db.execute(
                text("SELECT key,value FROM skill_state WHERE key LIKE 'pref:%'")
            )
            return {str(key)[5:]: str(value) for key, value in rows}

    async def list_values(self, prefix: str) -> list[str]:
        """前缀由程序生成，使用范围查询而不是允许通配符扩大范围。"""
        async with self._sessions() as db:
            rows = await db.execute(
                text("SELECT value FROM skill_state WHERE key>=:prefix AND key<:end ORDER BY key"),
                {"prefix": prefix, "end": prefix + "\uffff"},
            )
            return [str(row[0]) for row in rows]

    async def save(self, key: str, value: str, *, immutable: bool = False) -> str:
        async with self._sessions() as db, db.begin():
            conflict = "DO NOTHING" if immutable else "DO UPDATE SET value=excluded.value"
            await db.execute(
                text(
                    "INSERT INTO skill_state(key,value) VALUES (:key,:value) "
                    f"ON CONFLICT(key) {conflict}"
                ),
                {"key": key, "value": value},
            )
            result: str = (
                await db.execute(text("SELECT value FROM skill_state WHERE key=:key"), {"key": key})
            ).scalar_one()
            return result
