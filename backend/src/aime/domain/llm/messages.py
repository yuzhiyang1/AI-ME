"""与协议无关的对话消息模型。

这是模型对话能力的领域概念：无论底层是 OpenAI、Anthropic 还是其他厂商，
领域层和应用层都只认这里的表示。厂商请求体的序列化（system 放哪、
消息数组长什么样）是 infrastructure 协议适配器的职责，不允许泄漏到本层。
"""

from dataclasses import dataclass
from enum import StrEnum


class MessageRole(StrEnum):
    """消息角色。"""

    # 系统指令，仅用于构造请求输入，模型不会产出该角色
    SYSTEM = "system"
    # 用户发出的消息
    USER = "user"
    # 模型（或历史记录中的助手）发出的消息
    ASSISTANT = "assistant"


@dataclass(frozen=True, slots=True)
class ConversationMessage:
    """对话中的一条消息，领域内只认这一种表示。"""

    role: MessageRole  # 消息发出者；system 仅作输入，模型不会产出
    content: str  # 纯文本内容，多模态等 richer 表示未来再扩展

    def __post_init__(self) -> None:
        # 空白内容在入口处就拦下，避免把无效消息一路送到厂商 API 才报错
        if not self.content.strip():
            raise ValueError("消息内容不能为空")


@dataclass(frozen=True, slots=True)
class Conversation:
    """一次对话的消息序列。"""

    messages: tuple[ConversationMessage, ...]  # 按时间升序，末尾是最新的消息

    def __post_init__(self) -> None:
        # 空对话没有可补全的上下文，任何协议都无法发出请求
        if not self.messages:
            raise ValueError("对话至少需要一条消息")

    def last_user_message(self) -> ConversationMessage | None:
        """返回最后一条用户消息。"""
        for message in reversed(self.messages):
            if message.role is MessageRole.USER:
                return message
        return None
