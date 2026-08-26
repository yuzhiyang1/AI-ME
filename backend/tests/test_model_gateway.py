"""模型适配层的单元测试：事件翻译、路由分发与端口契约。

测试策略：用 SimpleNamespace 伪造最小 SDK 面（见各 _Fake* 桩），
不依赖 openai/anthropic 包。覆盖：
- OpenAI 协议：text/thinking 增量翻译、system 折叠、异常转 ERROR；
- Anthropic 协议：content block 增量翻译、system 独立参数与角色剔除；
- 网关：按 provider 路由、未知引用产出 ERROR、目录完整性。
已知盲区：假对象不随 SDK 版本演进，字段变更不会被本文件发现。
"""

from collections.abc import AsyncIterator
from types import SimpleNamespace as NS
from typing import Any

from aime.application.ports.model_gateway import (
    ApiKind,
    LlmCompletionRequest,
    ModelDescriptor,
)
from aime.domain.llm.events import LlmEventType, LlmStreamEvent
from aime.domain.llm.messages import ConversationMessage, MessageRole
from aime.infrastructure.llm.anthropic_messages import AnthropicMessagesApi
from aime.infrastructure.llm.catalog import BUILTIN_PROVIDERS
from aime.infrastructure.llm.model_gateway_impl import (
    ProtocolModelGateway,
    ProviderRuntime,
)
from aime.infrastructure.llm.openai_completions import OpenAICompletionsApi

USER = ConversationMessage(role=MessageRole.USER, content="你好")


def _descriptor(provider: str = "fake", model_id: str = "m1") -> ModelDescriptor:
    return ModelDescriptor(
        provider=provider,
        model_id=model_id,
        api=ApiKind.OPENAI_COMPLETIONS,
        display_name="Fake Model",
        context_window=1000,
    )


async def _collect(stream: AsyncIterator[LlmStreamEvent]) -> list[LlmStreamEvent]:
    return [event async for event in stream]


# ---------- OpenAI 协议：SDK 桩与翻译测试 ----------


class _FakeOpenAIChunkStream:
    def __init__(self, chunks: list[Any]) -> None:
        self._chunks = chunks

    def __aiter__(self) -> AsyncIterator[Any]:
        async def gen() -> AsyncIterator[Any]:
            for chunk in self._chunks:
                yield chunk

        return gen()


def _openai_chunk(content: str | None, reasoning: str | None = None) -> Any:
    delta = NS(content=content, reasoning_content=reasoning)
    return NS(choices=[NS(delta=delta)])


class _FakeCreate:
    def __init__(self, chunks: list[Any]) -> None:
        self._chunks = chunks
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> _FakeOpenAIChunkStream:
        self.calls.append(kwargs)
        return _FakeOpenAIChunkStream(self._chunks)


def _openai_api(create: _FakeCreate) -> OpenAICompletionsApi:
    client = NS(chat=NS(completions=NS(create=create)))
    return OpenAICompletionsApi(client)  # type: ignore[arg-type]


async def test_openai_translates_text_and_thinking_deltas() -> None:
    create = _FakeCreate([_openai_chunk("你", "思考中"), _openai_chunk("好", None)])
    api = _openai_api(create)

    events = await _collect(api.stream("gpt-4o", [USER], "系统", None, None))

    assert [event.type for event in events] == [
        LlmEventType.START,
        LlmEventType.THINKING_DELTA,
        LlmEventType.TEXT_DELTA,
        LlmEventType.TEXT_DELTA,
        LlmEventType.DONE,
    ]
    assert events[2].content == "你"
    # system 折叠为第一条 system 消息
    assert create.calls[0]["messages"][0] == {"role": "system", "content": "系统"}


async def test_openai_error_ends_stream_with_error_event() -> None:
    class _Boom:
        async def __call__(self, **kwargs: Any) -> Any:
            raise RuntimeError("网络错误")

    api = _openai_api(_Boom())  # type: ignore[arg-type]
    events = await _collect(api.stream("gpt-4o", [USER], None, None, None))
    assert events[-1].type is LlmEventType.ERROR
    assert "网络错误" in events[-1].content


# ---------- Anthropic 协议：SDK 桩与翻译测试 ----------


class _FakeAnthropicStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __aiter__(self) -> AsyncIterator[Any]:
        async def gen() -> AsyncIterator[Any]:
            for event in self._events:
                yield event

        return gen()


class _FakeAnthropicCreate:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> _FakeAnthropicStream:
        self.calls.append(kwargs)
        return _FakeAnthropicStream(self._events)


def _anthropic_event(delta_type: str, **fields: str) -> Any:
    return NS(type="content_block_delta", delta=NS(type=delta_type, **fields))


async def test_anthropic_translates_block_deltas() -> None:
    create = _FakeAnthropicCreate(
        [
            _anthropic_event("thinking_delta", thinking="推理"),
            _anthropic_event("text_delta", text="回答"),
            NS(type="message_stop"),
        ]
    )
    client = NS(messages=NS(create=create))
    api = AnthropicMessagesApi(client)  # type: ignore[arg-type]

    events = await _collect(api.stream("claude-sonnet-4-5", [USER], "系统", None, None))

    assert [event.type for event in events] == [
        LlmEventType.START,
        LlmEventType.THINKING_DELTA,
        LlmEventType.TEXT_DELTA,
        LlmEventType.DONE,
    ]
    call = create.calls[0]
    # system 走独立参数，messages 里不出现 system 角色
    assert call["system"] == "系统"
    assert all(message["role"] != "system" for message in call["messages"])
    assert call["max_tokens"] == 4096


# ---------- 网关：路由分发与引用解析 ----------


class _RecordingApi:
    def __init__(self) -> None:
        self.calls: list[Any] = []

    async def stream(
        self,
        model_id: str,
        messages: list[ConversationMessage],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> AsyncIterator[LlmStreamEvent]:
        self.calls.append((model_id, messages, system))
        yield LlmStreamEvent.text("hi")
        yield LlmStreamEvent.done()


def _gateway_with(*apis: _RecordingApi) -> ProtocolModelGateway:
    runtimes = [
        ProviderRuntime(definition=provider, api=api)
        for provider, api in zip(BUILTIN_PROVIDERS, apis, strict=True)
    ]
    return ProtocolModelGateway(runtimes)


async def test_gateway_routes_by_provider() -> None:
    openai_api, deepseek_api, anthropic_api = _RecordingApi(), _RecordingApi(), _RecordingApi()
    gateway = _gateway_with(openai_api, deepseek_api, anthropic_api)

    events = await _collect(
        gateway.stream(
            LlmCompletionRequest(
                model_ref="deepseek/deepseek-chat",
                messages=[USER],
                system="s",
            )
        )
    )

    assert [event.type for event in events] == [LlmEventType.TEXT_DELTA, LlmEventType.DONE]
    # 只有 deepseek 协议实例被调用
    assert deepseek_api.calls and not openai_api.calls and not anthropic_api.calls


async def test_gateway_unknown_model_yields_error_event() -> None:
    gateway = _gateway_with(_RecordingApi(), _RecordingApi(), _RecordingApi())
    events = await _collect(
        gateway.stream(LlmCompletionRequest(model_ref="nope/m1", messages=[USER]))
    )
    assert len(events) == 1
    assert events[0].type is LlmEventType.ERROR


def test_builtin_catalog_covers_two_protocols() -> None:
    apis = {provider.api for provider in BUILTIN_PROVIDERS}
    assert apis == {ApiKind.OPENAI_COMPLETIONS, ApiKind.ANTHROPIC_MESSAGES}
    refs = [model.ref for provider in BUILTIN_PROVIDERS for model in provider.models]
    assert len(refs) == len(set(refs))
