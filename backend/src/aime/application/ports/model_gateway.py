"""模型网关端口及其稳定的应用层数据契约。"""

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, TypeAlias


class MessageRole(StrEnum):
    """对话历史允许的消息角色；系统提示词不属于消息历史。"""

    USER = "user"
    ASSISTANT = "assistant"


@dataclass(frozen=True, slots=True)
class ConversationMessage:
    """提交给模型的一条用户或助手消息。"""

    role: MessageRole
    content: str

    def __post_init__(self) -> None:
        if not self.content.strip():
            raise ValueError("消息内容不能为空")


@dataclass(frozen=True, slots=True)
class ModelDescriptor:
    """应用层可见的模型元数据，不暴露底层传输协议。"""

    provider: str
    model_id: str
    display_name: str
    context_window: int

    @property
    def ref(self) -> str:
        """返回全局唯一的 ``provider/model`` 引用。"""
        return f"{self.provider}/{self.model_id}"


@dataclass(frozen=True, slots=True)
class LlmCompletionRequest:
    """一次流式补全请求；system 是系统提示词的唯一来源。"""

    model_ref: str
    messages: Sequence[ConversationMessage]
    system: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None


class LlmFinishReason(StrEnum):
    """跨厂商统一的流结束原因。"""

    STOP = "stop"
    LENGTH = "length"
    TOOL_CALLS = "tool_calls"
    CONTENT_FILTER = "content_filter"
    PAUSE = "pause"
    OTHER = "other"


class LlmErrorCategory(StrEnum):
    """供 Agent Runtime 决定是否重试的错误类别。"""

    INVALID_REQUEST = "invalid_request"
    AUTHENTICATION = "authentication"
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    CONNECTION = "connection"
    PROVIDER = "provider"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class LlmUsage:
    """一次模型调用的 token 用量；厂商未返回的字段为 None。"""

    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class LlmError:
    """结构化调用错误。"""

    category: LlmErrorCategory
    code: str
    message: str
    retryable: bool


@dataclass(frozen=True, slots=True)
class LlmStreamStarted:
    """模型流已经建立。"""


@dataclass(frozen=True, slots=True)
class LlmTextDelta:
    """回答正文增量。"""

    delta: str


@dataclass(frozen=True, slots=True)
class LlmThinkingDelta:
    """推理内容增量。"""

    delta: str


@dataclass(frozen=True, slots=True)
class LlmToolCallDelta:
    """工具调用增量；参数可能跨多个事件拼接。"""

    index: int
    call_id: str | None
    name: str | None
    arguments_delta: str


@dataclass(frozen=True, slots=True)
class LlmStreamCompleted:
    """模型流正常结束。"""

    finish_reason: LlmFinishReason
    usage: LlmUsage | None = None


@dataclass(frozen=True, slots=True)
class LlmStreamFailed:
    """模型流异常结束。"""

    error: LlmError


LlmStreamEvent: TypeAlias = (
    LlmStreamStarted
    | LlmTextDelta
    | LlmThinkingDelta
    | LlmToolCallDelta
    | LlmStreamCompleted
    | LlmStreamFailed
)


class ModelGateway(Protocol):
    """由基础设施层实现的模型调用端口。"""

    def list_models(self) -> list[ModelDescriptor]: ...

    def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]: ...
