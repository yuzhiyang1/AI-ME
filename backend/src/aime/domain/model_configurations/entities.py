"""不包含密钥的模型配置实体。"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class ModelProtocol(StrEnum):
    """AI-ME 当前支持的模型厂商协议。"""

    OPENAI_COMPLETIONS = "openai_completions"
    ANTHROPIC_MESSAGES = "anthropic_messages"


@dataclass(frozen=True, slots=True)
class ModelConfiguration:
    """一个由用户在本机设置中创建的可调用模型。"""

    id: UUID
    provider: str
    model_id: str
    display_name: str
    protocol: ModelProtocol
    base_url: str | None
    context_window: int
    created_at: datetime
    updated_at: datetime

    @property
    def model_ref(self) -> str:
        """返回会话持久化使用的全局模型引用。"""
        return f"{self.provider}/{self.model_id}"
