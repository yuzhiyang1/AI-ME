"""Project 聚合。"""

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4


@dataclass(frozen=True, slots=True)
class ProjectRoot:
    """项目关联的一个有序目录；位置 0 是唯一主目录。"""

    path: str
    position: int

    @property
    def primary(self) -> bool:
        """返回该目录是否承担新会话的默认工作目录。"""
        return self.position == 0


@dataclass(slots=True)
class Project:
    """用于组织会话并提供目录模板的本地项目。"""

    id: UUID
    name: str
    roots: tuple[ProjectRoot, ...]
    position: int
    created_at: datetime
    updated_at: datetime

    @classmethod
    def create(cls, *, name: str, roots: tuple[str, ...], position: int) -> "Project":
        """创建满足名称、目录数量和连续顺序不变量的 Project。"""
        normalized_name = name.strip()
        if not normalized_name or len(normalized_name) > 120:
            raise ValueError("项目名称不能为空且最长 120 个字符")
        if not roots:
            raise ValueError("项目至少需要一个目录")
        now = datetime.now(UTC)
        return cls(
            id=uuid4(),
            name=normalized_name,
            roots=tuple(ProjectRoot(path=path, position=index) for index, path in enumerate(roots)),
            position=position,
            created_at=now,
            updated_at=now,
        )

    def update(self, *, name: str, roots: tuple[str, ...]) -> None:
        """用完整新值更新项目，同时重新生成连续目录顺序。"""
        normalized_name = name.strip()
        if not normalized_name or len(normalized_name) > 120:
            raise ValueError("项目名称不能为空且最长 120 个字符")
        if not roots:
            raise ValueError("项目至少需要一个目录")
        self.name = normalized_name
        self.roots = tuple(
            ProjectRoot(path=path, position=index) for index, path in enumerate(roots)
        )
        self.updated_at = datetime.now(UTC)
