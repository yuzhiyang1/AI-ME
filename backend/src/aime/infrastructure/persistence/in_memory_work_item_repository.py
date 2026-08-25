"""开发期内存仓储实现。"""

from aime.domain.work_items.entities import WorkItem
from aime.domain.work_items.value_objects import WorkItemId


class InMemoryWorkItemRepository:
    """用于本地开发与测试的工作事项仓储。"""

    def __init__(self) -> None:
        self._items: dict[WorkItemId, WorkItem] = {}

    async def add(self, item: WorkItem) -> None:
        """保存工作事项。"""
        self._items[item.id] = item

    async def get(self, item_id: WorkItemId) -> WorkItem | None:
        """读取工作事项。"""
        return self._items.get(item_id)

    async def list_all(self) -> list[WorkItem]:
        """按创建时间列出工作事项。"""
        return sorted(self._items.values(), key=lambda item: item.created_at)

