"""模型网关端口：应用层面对大模型的唯一出入口。

六边形架构的关键约定：端口（接口）归应用层所有，infrastructure 实现它。
因此这里的类型定义一旦稳定就很难改（全项目都依赖它），改动需要走 CR。
"""

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from aime.domain.llm.events import LlmStreamEvent
from aime.domain.llm.messages import ConversationMessage


class ApiKind(StrEnum):
    """底层协议种类，参考 pi 的 provider/api 解耦设计。

    厂商（provider）与协议（api）是多对一关系：DeepSeek、Moonshot 等
    OpenAI 兼容服务都复用 OPENAI_COMPLETIONS 一种协议实现。
    新增一种协议意味着新写一个 infrastructure/llm/<protocol>.py 适配器；
    而新增一家厂商通常只是 catalog.py 里的一条元数据。
    """

    # OpenAI /chat/completions 及一切兼容它的服务
    OPENAI_COMPLETIONS = "openai-completions"
    # Anthropic /v1/messages（Claude 系）
    ANTHROPIC_MESSAGES = "anthropic-messages"


@dataclass(frozen=True, slots=True)
class ModelDescriptor:
    """一个可调用模型的元数据。"""

    provider: str  # 所属厂商 id，如 "anthropic"，同时是 ref 的第一段
    model_id: str  # 厂商侧的模型标识，如 "claude-sonnet-4-5"，不能含斜杠
    api: ApiKind  # 该模型走哪个协议适配器
    display_name: str  # 面向用户的显示名，与 model_id 解耦以便改名
    context_window: int  # 上下文窗口大小（token 数），用于调用方做长度预算

    @property
    def ref(self) -> str:
        """全局引用名，形如 ``anthropic/claude-sonnet-4-5``。

        这是 stream() 入参和 HTTP ``model`` 字段的统一寻址格式。
        注意：解析按第一个 "/" 切分，模型 id 本身不能包含斜杠。
        """
        return f"{self.provider}/{self.model_id}"


@dataclass(frozen=True, slots=True)
class LlmCompletionRequest:
    """一次补全请求（流式）。

    system 单独传而不是混在 messages 里，由各协议适配器决定其落位
    （OpenAI 折叠为首条 system 消息，Anthropic 走独立参数）。
    """

    model_ref: str  # 目标模型引用，形如 "provider/model_id"（见 ModelDescriptor.ref）
    messages: Sequence[ConversationMessage]  # 对话历史，至少一条
    system: str | None = None  # 系统提示词；None 表示不带
    max_tokens: int | None = None  # 输出上限；None 时交给协议缺省（Anthropic 为 4096）
    temperature: float | None = None  # 采样温度 0.0~2.0；None 表示用厂商默认值


class ModelGateway(Protocol):
    """由 infrastructure 的协议适配层实现的应用端口。"""

    def list_models(self) -> list[ModelDescriptor]:
        """列出当前已配置可用的模型。

        “可用”指对应厂商已配置 API key；未配置的厂商不进入运行时，
        因此调用方无需再做二次可用性判断。
        """
        ...

    def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        """按统一事件协议流式补全。

        错误约定（与 pi 一致）：请求期错误（如未知模型引用）和流中异常
        都翻译为一条 ERROR 事件终止流，不向调用方抛出。调用方只需要
        一种消费方式。
        """
        ...
