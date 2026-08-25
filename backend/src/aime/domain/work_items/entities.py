"""工作事项聚合。"""

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from aime.domain.work_items.exceptions import InvalidWorkItemTransition
from aime.domain.work_items.value_objects import WorkItemId, WorkItemStatus, WorkItemTitle


@dataclass(slots=True)
class WorkItem:
    """用户交给 AI-ME 托管的一项工作。"""

    id: WorkItemId
    title: WorkItemTitle
    status: WorkItemStatus
    created_at: datetime

    @classmethod
    def create(cls, title: WorkItemTitle) -> "WorkItem":
        """创建一个等待处理的工作事项。"""
        return cls(
            id=WorkItemId(uuid4()),
            title=title,
            status=WorkItemStatus.PENDING,
            created_at=datetime.now(UTC),
        )

    def start(self) -> None:
        """开始处理工作事项。"""
        if self.status is not WorkItemStatus.PENDING:
            raise InvalidWorkItemTransition("只有待处理事项可以开始")
        self.status = WorkItemStatus.IN_PROGRESS

    def complete(self) -> None:
        """完成工作事项。"""
        if self.status is not WorkItemStatus.IN_PROGRESS:
            raise InvalidWorkItemTransition("只有处理中事项可以完成")
        self.status = WorkItemStatus.COMPLETED

