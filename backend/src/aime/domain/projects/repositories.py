"""Project 仓储端口。"""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from aime.domain.projects.entities import Project


class ProjectIdempotencyConflict(RuntimeError):
    """同一个幂等键已经绑定到另一份项目创建请求。"""


@dataclass(frozen=True, slots=True)
class ProjectCreateResult:
    """项目创建结果；重复请求会返回原有项目。"""

    project: Project
    repeated: bool


class ProjectRepository(Protocol):
    """由基础设施层实现的 Project 持久化端口。"""

    async def create(
        self,
        project: Project,
        *,
        idempotency_key: str,
        request_hash: str,
    ) -> ProjectCreateResult: ...

    async def get(self, project_id: UUID) -> Project | None: ...

    async def list_all(self) -> list[Project]: ...

    async def update(self, project: Project) -> bool: ...

    async def delete(self, project_id: UUID) -> bool: ...
