"""HTTP 请求与响应结构。"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from aime.domain.work_items.entities import WorkItem
from aime.domain.work_items.value_objects import WorkItemStatus


class HealthResponse(BaseModel):
    """服务健康状态。"""

    status: str
    service: str


class CreateWorkItemRequest(BaseModel):
    """创建工作事项请求。"""

    title: str = Field(min_length=1, max_length=120)


class WorkItemResponse(BaseModel):
    """工作事项响应。"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    status: WorkItemStatus
    created_at: datetime

    @classmethod
    def from_domain(cls, item: WorkItem) -> "WorkItemResponse":
        """将领域对象转换为 HTTP DTO。"""
        return cls(
            id=item.id.value,
            title=item.title.value,
            status=item.status,
            created_at=item.created_at,
        )

