"""Anthropic Messages 协议实现。

与 OpenAI 协议的关键差异（也是本模块存在的理由）：
- system prompt 走独立参数，messages 里不允许出现 system 角色；
- thinking 是消息中的一等公民，以独立 content block 的增量下发；
- max_tokens 必填，缺省取 4096。
"""

from collections.abc import AsyncIterator
from typing import Any, Protocol

from aime.domain.llm.events import LlmStreamEvent
from aime.domain.llm.messages import ConversationMessage, MessageRole


class _MessagesClient(Protocol):
    """本模块依赖的最小 SDK 面，便于测试注入（理由同 openai_completions）。"""

    @property
    def messages(self) -> Any: ...


class AnthropicMessagesApi:
    """把 Anthropic messages 流翻译成统一事件协议。"""

    def __init__(self, client: _MessagesClient) -> None:
        self._client = client  # Anthropic SDK 的异步 client，由工厂或测试注入

    async def stream(
        self,
        model_id: str,
        messages: list[ConversationMessage],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> AsyncIterator[LlmStreamEvent]:
        # Anthropic 的 messages 只接受 user/assistant，system 角色静默剔除
        payload_messages = [
            {"role": message.role.value, "content": message.content}
            for message in messages
            if message.role is not MessageRole.SYSTEM
        ]
        kwargs: dict[str, Any] = {
            "model": model_id,
            "messages": payload_messages,
            # Anthropic API 的必填项，端口未指定时用保守缺省值
            "max_tokens": max_tokens if max_tokens is not None else 4096,
        }
        if system is not None:
            kwargs["system"] = system
        if temperature is not None:
            kwargs["temperature"] = temperature
        yield LlmStreamEvent.start()
        try:
            events = await self._client.messages.create(**kwargs, stream=True)
            async for event in events:
                # 只关心文本/思考增量；message_start、ping 等骨架事件忽略
                if event.type == "content_block_delta":
                    if event.delta.type == "text_delta":
                        yield LlmStreamEvent.text(event.delta.text)
                    elif event.delta.type == "thinking_delta":
                        yield LlmStreamEvent.thinking(event.delta.thinking)
        except Exception as exc:  # noqa: BLE001 - 错误统一以事件终止流
            yield LlmStreamEvent.error(str(exc))
            return
        yield LlmStreamEvent.done()


def build_anthropic_messages_api(api_key: str, base_url: str | None = None) -> AnthropicMessagesApi:
    """用真实 SDK client 构建协议实现（延迟 import，理由同 openai_completions）。"""
    from anthropic import AsyncAnthropic

    if base_url:
        client = AsyncAnthropic(api_key=api_key, base_url=base_url)
    else:
        client = AsyncAnthropic(api_key=api_key)
    return AnthropicMessagesApi(client)
