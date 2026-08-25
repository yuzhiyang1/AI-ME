"""工作事项应用服务。"""

from aime.application.work_items.commands import CreateWorkItemCommand
from aime.domain.work_items.entities import WorkItem
from aime.domain.work_items.repositories import WorkItemRepository
from aime.domain.work_items.value_objects import WorkItemTitle


class CreateWorkItem:
    """创建并保存工作事项。"""

    def __init__(self, repository: WorkItemRepository) -> None:
        self._repository = repository

    async def execute(self, command: CreateWorkItemCommand) -> WorkItem:
        """执行创建用例。"""
        item = WorkItem.create(WorkItemTitle(command.title))
        await self._repository.add(item)
        return item


class ListWorkItems:
    """查询当前全部工作事项。"""

    def __init__(self, repository: WorkItemRepository) -> None:
        self._repository = repository

    async def execute(self) -> list[WorkItem]:
        """执行列表查询。"""
        return await self._repository.list_all()

