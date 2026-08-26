"""OpenAI Chat Completions 协议实现。

覆盖所有 OpenAI 兼容服务（OpenAI、DeepSeek、Moonshot、本地 Ollama 等）。
协议翻译职责：
- 统一消息 -> 请求体：system 折叠为首条 system 消息；
- 分块流 -> 统一事件：``delta.content`` -> TEXT_DELTA，
  DeepSeek 风格的 ``reasoning_content`` -> THINKING_DELTA。
"""

from collections.abc import AsyncIterator
from typing import Any, Protocol

from aime.domain.llm.events import LlmStreamEvent
from aime.domain.llm.messages import ConversationMessage


class _ChatCompletionsClient(Protocol):
    """本模块依赖的最小 SDK 面，便于测试注入。

    只声明真实用到的 chat 属性：AsyncOpenAI 满足它，
    测试里用 SimpleNamespace 即可伪造。SDK 类型不进入方法签名，
    从而保证 openai 包只在工厂函数里被 import。
    """

    @property
    def chat(self) -> Any: ...


class OpenAICompletionsApi:
    """把 chat.completions 流翻译成统一事件协议。"""

    def __init__(self, client: _ChatCompletionsClient) -> None:
        self._client = client  # OpenAI SDK 的异步 client，由工厂或测试注入

    async def stream(
        self,
        model_id: str,
        messages: list[ConversationMessage],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> AsyncIterator[LlmStreamEvent]:
        # 序列化统一消息：system 放在消息列表开头（OpenAI 惯例）
        payload_messages: list[dict[str, str]] = []
        if system is not None:
            payload_messages.append({"role": "system", "content": system})
        payload_messages.extend(
            {"role": message.role.value, "content": message.content} for message in messages
        )
        kwargs: dict[str, Any] = {
            "model": model_id,
            "messages": payload_messages,
            "stream": True,
        }
        # 可选参数仅在显式给出时下发，保持各厂商缺省行为
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if temperature is not None:
            kwargs["temperature"] = temperature
        yield LlmStreamEvent.start()
        try:
            chunks = await self._client.chat.completions.create(**kwargs)
            async for chunk in chunks:
                # 心跳分块可能不带 choices，空列表直接跳过
                for choice in chunk.choices or []:
                    delta = choice.delta
                    # reasoning_content 不是 OpenAI 官方字段而是 DeepSeek 扩展，
                    # SDK 类型上不存在，所以用 getattr 探测；有则先于正文产出
                    reasoning = getattr(delta, "reasoning_content", None)
                    if reasoning:
                        yield LlmStreamEvent.thinking(reasoning)
                    if delta.content:
                        yield LlmStreamEvent.text(delta.content)
        except Exception as exc:  # noqa: BLE001 - 错误统一以事件终止流
            # 端口契约：流中任何异常都翻译成 ERROR 事件，return 保证
            # ERROR 之后不再有事件
            yield LlmStreamEvent.error(str(exc))
            return
        yield LlmStreamEvent.done()


def build_openai_completions_api(api_key: str, base_url: str | None = None) -> OpenAICompletionsApi:
    """用真实 SDK client 构建协议实现。

    SDK 在这里（而非模块顶部）import：未配置 key 的进程不加载 openai 包。
    """
    from openai import AsyncOpenAI

    if base_url:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    else:
        client = AsyncOpenAI(api_key=api_key)
    return OpenAICompletionsApi(client)
