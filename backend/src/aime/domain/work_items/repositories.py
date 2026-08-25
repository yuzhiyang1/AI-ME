"""工作事项仓储端口。"""

from typing import Protocol

from aime.domain.work_items.entities import WorkItem
from aime.domain.work_items.value_objects import WorkItemId


class WorkItemRepository(Protocol):
    """由基础设施层实现的工作事项仓储。"""

    async def add(self, item: WorkItem) -> None:
        """保存工作事项。"""
        ...

    async def get(self, item_id: WorkItemId) -> WorkItem | None:
        """按标识读取工作事项。"""
        ...

    async def list_all(self) -> list[WorkItem]:
        """列出全部工作事项。"""
        ...

