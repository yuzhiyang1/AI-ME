"""应用装配根。所有具体实现只在这里接线。"""

from dataclasses import dataclass

from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.infrastructure.persistence.in_memory_work_item_repository import (
    InMemoryWorkItemRepository,
)


@dataclass(slots=True)
class Container:
    """模块化单体的依赖容器。"""

    create_work_item: CreateWorkItem
    list_work_items: ListWorkItems


def build_container() -> Container:
    """创建应用所需的依赖图。"""
    work_items = InMemoryWorkItemRepository()
    return Container(
        create_work_item=CreateWorkItem(work_items),
        list_work_items=ListWorkItems(work_items),
    )

