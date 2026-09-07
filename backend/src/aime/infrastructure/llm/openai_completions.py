"""OpenAI Chat Completions 协议适配器。"""

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


class _ChatCompletionsClient(Protocol):
    """协议适配器使用的最小 SDK 接口。"""

    @property
    def chat(self) -> Any: ...


class OpenAICompletionsApi:
    """把 OpenAI 兼容流翻译为统一 Provider Event。"""

    def __init__(self, client: _ChatCompletionsClient) -> None:
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
        payload_messages: list[dict[str, Any]] = []
        if system is not None:
            payload_messages.append({"role": "system", "content": system})
        payload_messages.extend(_openai_message(message) for message in messages)
        kwargs: dict[str, Any] = {
            "model": model_id,
            "messages": payload_messages,
            "stream": True,
            # OpenAI 兼容流默认不会返回 usage，显式请求终止分片中的计费数据。
            "stream_options": {"include_usage": True},
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if temperature is not None:
            kwargs["temperature"] = temperature
        if tools:
            kwargs["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                }
                for tool in tools
            ]
            kwargs["parallel_tool_calls"] = parallel_tool_calls

        yield LlmStreamStarted()
        finish_reason = LlmFinishReason.STOP
        usage: LlmUsage | None = None
        try:
            chunks = await self._client.chat.completions.create(**kwargs)
            async for chunk in chunks:
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    usage = LlmUsage(
                        input_tokens=getattr(chunk_usage, "prompt_tokens", None),
                        output_tokens=getattr(chunk_usage, "completion_tokens", None),
                    )
                for choice in getattr(chunk, "choices", None) or []:
                    reason = getattr(choice, "finish_reason", None)
                    if reason is not None:
                        finish_reason = normalize_finish_reason(reason)
                    delta = choice.delta
                    reasoning = getattr(delta, "reasoning_content", None)
                    if reasoning:
                        yield LlmThinkingDelta(reasoning)
                    for tool_call in getattr(delta, "tool_calls", None) or []:
                        function = getattr(tool_call, "function", None)
                        yield LlmToolCallDelta(
                            index=tool_call.index,
                            call_id=getattr(tool_call, "id", None),
                            name=getattr(function, "name", None),
                            arguments_delta=getattr(function, "arguments", "") or "",
                        )
                    if getattr(delta, "content", None):
                        yield LlmTextDelta(delta.content)
        except Exception as exc:  # noqa: BLE001 - 统一在事件流内表达 SDK 错误
            yield LlmStreamFailed(classify_provider_error(exc))
            return
        yield LlmStreamCompleted(finish_reason=finish_reason, usage=usage)


def _openai_message(
    message: ConversationMessage | LlmAssistantToolCallMessage | LlmToolResultMessage,
) -> dict[str, Any]:
    """把统一消息翻译为 Chat Completions 消息结构。"""
    if isinstance(message, ConversationMessage):
        return {"role": message.role.value, "content": message.content}
    if isinstance(message, LlmAssistantToolCallMessage):
        return {
            "role": "assistant",
            "content": message.content or None,
            "tool_calls": [
                {
                    "id": call.call_id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": call.arguments_json,
                    },
                }
                for call in message.tool_calls
            ],
        }
    return {
        "role": "tool",
        "tool_call_id": message.call_id,
        "content": message.content,
    }


def build_openai_completions_api(api_key: str, base_url: str | None = None) -> OpenAICompletionsApi:
    """延迟导入 SDK，构建协议适配器。"""
    from openai import AsyncOpenAI

    client = (
        AsyncOpenAI(api_key=api_key, base_url=base_url)
        if base_url
        else AsyncOpenAI(api_key=api_key)
    )
    return OpenAICompletionsApi(client)
