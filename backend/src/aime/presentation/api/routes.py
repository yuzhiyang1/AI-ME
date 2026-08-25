"""AI-ME HTTP 路由。"""

from fastapi import APIRouter, status

from aime.application.work_items.commands import CreateWorkItemCommand
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.presentation.api.schemas import (
    CreateWorkItemRequest,
    HealthResponse,
    WorkItemResponse,
)


def build_router(create_work_item: CreateWorkItem, list_work_items: ListWorkItems) -> APIRouter:
    """使用已经装配好的用例创建路由。"""
    router = APIRouter(prefix="/api")

    @router.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", service="ai-me")

    @router.post(
        "/work-items",
        response_model=WorkItemResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create(payload: CreateWorkItemRequest) -> WorkItemResponse:
        item = await create_work_item.execute(CreateWorkItemCommand(title=payload.title))
        return WorkItemResponse.from_domain(item)

    @router.get("/work-items", response_model=list[WorkItemResponse])
    async def list_items() -> list[WorkItemResponse]:
        items = await list_work_items.execute()
        return [WorkItemResponse.from_domain(item) for item in items]

    return router

