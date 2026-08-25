"""工作事项值对象。"""

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID


@dataclass(frozen=True, slots=True)
class WorkItemId:
    """工作事项的稳定标识。"""

    value: UUID


@dataclass(frozen=True, slots=True)
class WorkItemTitle:
    """经过领域校验的工作事项标题。"""

    value: str

    def __post_init__(self) -> None:
        normalized = self.value.strip()
        if not normalized:
            raise ValueError("工作事项标题不能为空")
        if len(normalized) > 120:
            raise ValueError("工作事项标题不能超过 120 个字符")
        object.__setattr__(self, "value", normalized)


class WorkItemStatus(StrEnum):
    """工作事项生命周期状态。"""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"

