"""应用装配根。所有具体实现只在这里接线。"""

from dataclasses import dataclass

from aime.application.models.services import ListAvailableModels, StreamModelCompletion
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.infrastructure.llm.model_gateway_impl import build_gateway_from_env
from aime.infrastructure.persistence.in_memory_work_item_repository import (
    InMemoryWorkItemRepository,
)


@dataclass(slots=True)
class Container:
    """模块化单体的依赖容器。"""

    create_work_item: CreateWorkItem
    list_work_items: ListWorkItems
    list_available_models: ListAvailableModels
    stream_model_completion: StreamModelCompletion


def build_container() -> Container:
    """创建应用所需的依赖图。

    模型网关按环境变量装配：未配置任何 AIME_*_API_KEY 时得到
    空模型列表的网关（不加载任何厂商 SDK），其余用例不受影响。
    """
    work_items = InMemoryWorkItemRepository()
    model_gateway = build_gateway_from_env()
    return Container(
        create_work_item=CreateWorkItem(work_items),
        list_work_items=ListWorkItems(work_items),
        list_available_models=ListAvailableModels(model_gateway),
        stream_model_completion=StreamModelCompletion(model_gateway),
    )
