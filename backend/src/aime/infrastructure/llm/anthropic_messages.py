"""Anthropic Messages 协议适配器。"""

import json
from collections.abc import AsyncIterator
from typing import Any, Protocol

from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmAssistantToolCallMessage,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamFailed,
    LlmStreamStarted,
    LlmTextDelta,
    LlmThinkingDelta,
    LlmToolCallDelta,
    LlmToolDefinition,
    LlmToolResultMessage,
    LlmUsage,
)
from aime.infrastructure.llm.errors import classify_provider_error, normalize_finish_reason


class _MessagesClient(Protocol):
    """协议适配器使用的最小 SDK 接口。"""

    @property
    def messages(self) -> Any: ...


class AnthropicMessagesApi:
    """把 Anthropic 流翻译为统一 Provider Event。"""

    def __init__(self, client: _MessagesClient) -> None:
        self._client = client

    async def stream(
        self,
        model_id: str,
        messages: list[ConversationMessage | LlmAssistantToolCallMessage | LlmToolResultMessage],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
        tools: list[LlmToolDefinition] | None = None,
        parallel_tool_calls: bool = True,
    ) -> AsyncIterator[LlmStreamEvent]:
        kwargs: dict[str, Any] = {
            "model": model_id,
            "messages": _anthropic_messages(messages),
            "max_tokens": max_tokens if max_tokens is not None else 4096,
        }
        if system is not None:
            kwargs["system"] = system
        if temperature is not None:
            kwargs["temperature"] = temperature
        if tools:
            kwargs["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }
                for tool in tools
            ]

        yield LlmStreamStarted()
        finish_reason = LlmFinishReason.STOP
        input_tokens: int | None = None
        output_tokens: int | None = None
        tool_blocks: dict[int, tuple[str | None, str | None]] = {}
        try:
            events = await self._client.messages.create(**kwargs, stream=True)
            async for event in events:
                if event.type == "message_start":
                    input_tokens = getattr(
                        getattr(event.message, "usage", None), "input_tokens", None
                    )
                elif event.type == "content_block_start" and event.content_block.type == "tool_use":
                    tool = (
                        getattr(event.content_block, "id", None),
                        getattr(event.content_block, "name", None),
                    )
                    tool_blocks[event.index] = tool
                    yield LlmToolCallDelta(event.index, tool[0], tool[1], "")
                elif event.type == "content_block_delta":
                    if event.delta.type == "text_delta":
                        yield LlmTextDelta(event.delta.text)
                    elif event.delta.type == "thinking_delta":
                        yield LlmThinkingDelta(event.delta.thinking)
                    elif event.delta.type == "input_json_delta":
                        call_id, name = tool_blocks.get(event.index, (None, None))
                        yield LlmToolCallDelta(
                            event.index,
                            call_id,
                            name,
                            getattr(event.delta, "partial_json", "") or "",
                        )
                elif event.type == "message_delta":
                    finish_reason = normalize_finish_reason(
                        getattr(event.delta, "stop_reason", None)
                    )
                    output_tokens = getattr(getattr(event, "usage", None), "output_tokens", None)
        except Exception as exc:  # noqa: BLE001 - 统一在事件流内表达 SDK 错误
            yield LlmStreamFailed(classify_provider_error(exc))
            return
        usage = (
            LlmUsage(input_tokens=input_tokens, output_tokens=output_tokens)
            if input_tokens is not None or output_tokens is not None
            else None
        )
        yield LlmStreamCompleted(finish_reason=finish_reason, usage=usage)


def _anthropic_messages(
    messages: list[ConversationMessage | LlmAssistantToolCallMessage | LlmToolResultMessage],
) -> list[dict[str, Any]]:
    """把统一消息翻译为 Messages API，并合并连续的工具结果。"""
    payload: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, ConversationMessage):
            payload.append({"role": message.role.value, "content": message.content})
        elif isinstance(message, LlmAssistantToolCallMessage):
            content: list[dict[str, Any]] = []
            if message.content:
                content.append({"type": "text", "text": message.content})
            content.extend(
                {
                    "type": "tool_use",
                    "id": call.call_id,
                    "name": call.name,
                    "input": _decode_arguments(call.arguments_json),
                }
                for call in message.tool_calls
            )
            payload.append({"role": "assistant", "content": content})
        else:
            result = {
                "type": "tool_result",
                "tool_use_id": message.call_id,
                "content": message.content,
                "is_error": message.is_error,
            }
            if (
                payload
                and payload[-1]["role"] == "user"
                and isinstance(payload[-1]["content"], list)
            ):
                payload[-1]["content"].append(result)
            else:
                payload.append({"role": "user", "content": [result]})
    return payload


def _decode_arguments(arguments_json: str) -> dict[str, object]:
    """无效参数仍交由 Runtime 处理，协议回放阶段使用空对象兜底。"""
    try:
        decoded = json.loads(arguments_json)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def build_anthropic_messages_api(api_key: str, base_url: str | None = None) -> AnthropicMessagesApi:
    """延迟导入 SDK，构建协议适配器。"""
    from anthropic import AsyncAnthropic

    client = (
        AsyncAnthropic(api_key=api_key, base_url=base_url)
        if base_url
        else AsyncAnthropic(api_key=api_key)
    )
    return AnthropicMessagesApi(client)
