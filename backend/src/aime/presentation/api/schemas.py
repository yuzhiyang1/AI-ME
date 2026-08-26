"""HTTP 请求与响应结构。"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from aime.application.ports.model_gateway import ModelDescriptor
from aime.domain.llm.messages import ConversationMessage, MessageRole
from aime.domain.work_items.entities import WorkItem
from aime.domain.work_items.value_objects import WorkItemStatus


class HealthResponse(BaseModel):
    """服务健康状态。"""

    status: str
    service: str


class CreateWorkItemRequest(BaseModel):
    """创建工作事项请求。"""

    title: str = Field(min_length=1, max_length=120)


class ModelResponse(BaseModel):
    """可调用模型的元数据。"""

    ref: str  # 全局引用名 "provider/model_id"，调用时传这个
    provider: str  # 所属厂商 id
    model_id: str  # 厂商侧模型标识
    display_name: str  # 面向用户的显示名
    context_window: int  # 上下文窗口大小（token 数）

    @classmethod
    def from_domain(cls, model: ModelDescriptor) -> "ModelResponse":
        """将模型元数据转换为 HTTP DTO。"""
        return cls(
            ref=model.ref,
            provider=model.provider,
            model_id=model.model_id,
            display_name=model.display_name,
            context_window=model.context_window,
        )


class ChatMessagePayload(BaseModel):
    """HTTP 层的消息载荷。"""

    role: MessageRole  # 消息角色：system / user / assistant
    content: str = Field(min_length=1)  # 消息正文，非空

    def to_domain(self) -> ConversationMessage:
        return ConversationMessage(role=self.role, content=self.content)


class ChatCompletionRequest(BaseModel):
    """一次流式补全请求。"""

    model: str  # 目标模型引用，形如 "provider/model_id"，见 ModelDescriptor.ref
    messages: list[ChatMessagePayload]  # 对话历史，按时间升序，至少一条
    system: str | None = None  # 系统提示词；None 表示不带
    max_tokens: int | None = Field(default=None, gt=0)  # 输出上限（正整数）；None 用协议缺省
    # 采样温度 0.0~2.0；None 用厂商默认
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)


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

