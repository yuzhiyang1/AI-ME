"""持久化模型消息的稳定表示，不保存厂商 SDK 对象。"""

import json
from dataclasses import asdict
from typing import Any

from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmAssistantToolCallMessage,
    LlmInputMessage,
    LlmToolCall,
    LlmToolResultMessage,
    MessageRole,
)


def encode_message(message: LlmInputMessage) -> dict[str, Any]:
    """为普通文本、工具调用和结果补充类型标签，避免恢复时仅凭 role 猜测结构。"""
    data = asdict(message)
    data["kind"] = (
        "call"
        if isinstance(message, LlmAssistantToolCallMessage)
        else "result"
        if isinstance(message, LlmToolResultMessage)
        else "text"
    )
    return data


def decode_message(data: dict[str, Any]) -> LlmInputMessage:
    """按持久化标签还原内部消息，保留调用 ID 以配对工具调用与结果。"""
    if data["kind"] == "call":
        return LlmAssistantToolCallMessage(
            tuple(LlmToolCall(**call) for call in data["tool_calls"]),
            data["content"],
        )
    if data["kind"] == "result":
        return LlmToolResultMessage(
            data["call_id"],
            data["name"],
            data["content"],
            data["is_error"],
        )
    return ConversationMessage(MessageRole(data["role"]), data["content"])


def dump_messages(messages: list[LlmInputMessage]) -> str:
    return json.dumps([encode_message(message) for message in messages], ensure_ascii=False)


def load_messages(content: str) -> list[LlmInputMessage]:
    return [decode_message(item) for item in json.loads(content)]
