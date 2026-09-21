"""Skill 文件访问和持久状态端口。"""

from typing import Protocol

from aime.domain.skills import Skill


class SkillResources(Protocol):
    """仅访问明确配置的 Skill 根，不扩展普通工具的工作区。"""

    async def discover(self, roots: tuple[str, ...]) -> tuple[list[Skill], list[str]]: ...

    async def read(self, skill: Skill, resource: str) -> str: ...


class SkillStateStore(Protocol):
    """不可变快照采用先写入者胜出，偏好采用原子更新。"""

    async def get(self, key: str) -> str | None: ...

    async def preferences(self) -> dict[str, str]: ...

    async def list_values(self, prefix: str) -> list[str]: ...

    async def save(self, key: str, value: str, *, immutable: bool = False) -> str: ...
