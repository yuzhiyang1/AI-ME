"""Anthropic Messages 协议适配器。"""

from collections.abc import AsyncIterator
from typing import Any, Protocol

from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamFailed,
    LlmStreamStarted,
    LlmTextDelta,
    LlmThinkingDelta,
    LlmToolCallDelta,
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
        messages: list[ConversationMessage],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> AsyncIterator[LlmStreamEvent]:
        kwargs: dict[str, Any] = {
            "model": model_id,
            "messages": [
                {"role": message.role.value, "content": message.content} for message in messages
            ],
            "max_tokens": max_tokens if max_tokens is not None else 4096,
        }
        if system is not None:
            kwargs["system"] = system
        if temperature is not None:
            kwargs["temperature"] = temperature

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


def build_anthropic_messages_api(api_key: str, base_url: str | None = None) -> AnthropicMessagesApi:
    """延迟导入 SDK，构建协议适配器。"""
    from anthropic import AsyncAnthropic

    client = (
        AsyncAnthropic(api_key=api_key, base_url=base_url)
        if base_url
        else AsyncAnthropic(api_key=api_key)
    )
    return AnthropicMessagesApi(client)
