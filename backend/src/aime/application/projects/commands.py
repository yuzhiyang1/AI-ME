"""Project 用例输入。"""

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class CreateProjectCommand:
    """创建 Project 所需的完整输入。"""

    name: str
    roots: tuple[str, ...]
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class UpdateProjectCommand:
    """替换 Project 名称及全部有序目录。"""

    project_id: UUID
    name: str
    roots: tuple[str, ...]
