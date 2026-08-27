"""模型网关契约测试：协议翻译、错误结构与厂商路由。"""

from collections.abc import AsyncIterator
from types import SimpleNamespace as NS
from typing import Any

from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmCompletionRequest,
    LlmErrorCategory,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamFailed,
    LlmTextDelta,
    LlmThinkingDelta,
    LlmToolCallDelta,
    MessageRole,
    ModelDescriptor,
)
from aime.infrastructure.llm.anthropic_messages import AnthropicMessagesApi
from aime.infrastructure.llm.catalog import BUILTIN_PROVIDERS, ApiKind, ProviderDefinition
from aime.infrastructure.llm.model_gateway_impl import ProtocolModelGateway, ProviderRuntime
from aime.infrastructure.llm.openai_completions import OpenAICompletionsApi

USER = ConversationMessage(role=MessageRole.USER, content="你好")


async def _collect(stream: AsyncIterator[LlmStreamEvent]) -> list[LlmStreamEvent]:
    return [event async for event in stream]


class _FakeStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __aiter__(self) -> AsyncIterator[Any]:
        async def generate() -> AsyncIterator[Any]:
            for event in self._events:
                yield event

        return generate()


class _FakeCreate:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> _FakeStream:
        self.calls.append(kwargs)
        return _FakeStream(self._events)


def _openai_api(create: Any) -> OpenAICompletionsApi:
    client = NS(chat=NS(completions=NS(create=create)))
    return OpenAICompletionsApi(client)  # type: ignore[arg-type]


async def test_openai_translates_tool_calls_finish_reason_and_usage() -> None:
    create = _FakeCreate(
        [
            NS(
                choices=[
                    NS(
                        delta=NS(
                            content=None,
                            reasoning_content="思考",
                            tool_calls=[
                                NS(
                                    index=0,
                                    id="call_1",
                                    function=NS(name="search", arguments='{"q":'),
                                )
                            ],
                        ),
                        finish_reason=None,
                    )
                ],
                usage=None,
            ),
            NS(
                choices=[
                    NS(
                        delta=NS(content="答案", reasoning_content=None, tool_calls=[]),
                        finish_reason="tool_calls",
                    )
                ],
                usage=NS(prompt_tokens=12, completion_tokens=7),
            ),
        ]
    )

    events = await _collect(_openai_api(create).stream("gpt-4o", [USER], "系统", None, None))

    assert isinstance(events[1], LlmThinkingDelta)
    assert isinstance(events[2], LlmToolCallDelta)
    assert events[2].call_id == "call_1"
    assert events[2].name == "search"
    assert events[2].arguments_delta == '{"q":'
    assert isinstance(events[3], LlmTextDelta)
    assert events[3].delta == "答案"
    assert isinstance(events[-1], LlmStreamCompleted)
    assert events[-1].finish_reason is LlmFinishReason.TOOL_CALLS
    assert events[-1].usage is not None
    assert events[-1].usage.input_tokens == 12
    assert events[-1].usage.output_tokens == 7
    assert create.calls[0]["messages"][0] == {"role": "system", "content": "系统"}


async def test_openai_classifies_retryable_provider_error() -> None:
    error_type = type("ServiceUnavailableError", (Exception,), {"status_code": 503})

    class _Boom:
        async def __call__(self, **kwargs: Any) -> Any:
            raise error_type("模型服务暂不可用")

    events = await _collect(_openai_api(_Boom()).stream("gpt-4o", [USER], None, None, None))

    assert isinstance(events[-1], LlmStreamFailed)
    assert events[-1].error.category is LlmErrorCategory.PROVIDER
    assert events[-1].error.retryable is True
    assert events[-1].error.code == "provider_unavailable"


async def test_anthropic_translates_tool_use_finish_reason_and_usage() -> None:
    create = _FakeCreate(
        [
            NS(type="message_start", message=NS(usage=NS(input_tokens=10))),
            NS(
                type="content_block_start",
                index=1,
                content_block=NS(type="tool_use", id="tool_1", name="lookup"),
            ),
            NS(
                type="content_block_delta",
                index=1,
                delta=NS(type="input_json_delta", partial_json='{"id":'),
            ),
            NS(
                type="message_delta",
                delta=NS(stop_reason="tool_use"),
                usage=NS(output_tokens=6),
            ),
        ]
    )
    client = NS(messages=NS(create=create))
    api = AnthropicMessagesApi(client)  # type: ignore[arg-type]

    events = await _collect(api.stream("claude-sonnet-4-5", [USER], "系统", None, None))

    tool_events = [event for event in events if isinstance(event, LlmToolCallDelta)]
    assert [(event.call_id, event.name, event.arguments_delta) for event in tool_events] == [
        ("tool_1", "lookup", ""),
        ("tool_1", "lookup", '{"id":'),
    ]
    assert isinstance(events[-1], LlmStreamCompleted)
    assert events[-1].finish_reason is LlmFinishReason.TOOL_CALLS
    assert events[-1].usage is not None
    assert events[-1].usage.input_tokens == 10
    assert events[-1].usage.output_tokens == 6
    assert create.calls[0]["system"] == "系统"
    assert create.calls[0]["messages"] == [{"role": "user", "content": "你好"}]


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
        yield LlmTextDelta("hi")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


def _provider(provider: str = "fake", model_id: str = "m1") -> ProviderDefinition:
    return ProviderDefinition(
        provider=provider,
        display_name="Fake",
        api=ApiKind.OPENAI_COMPLETIONS,
        base_url=None,
        api_key_env="AIME_FAKE_API_KEY",
        models=(ModelDescriptor(provider, model_id, "Fake Model", 1000),),
    )


async def test_gateway_routes_by_provider() -> None:
    api = _RecordingApi()
    gateway = ProtocolModelGateway([ProviderRuntime(definition=_provider(), api=api)])

    events = await _collect(
        gateway.stream(LlmCompletionRequest(model_ref="fake/m1", messages=[USER], system="s"))
    )

    assert isinstance(events[0], LlmTextDelta)
    assert api.calls == [("m1", [USER], "s")]


async def test_gateway_unknown_model_yields_structured_error() -> None:
    gateway = ProtocolModelGateway([])
    events = await _collect(
        gateway.stream(LlmCompletionRequest(model_ref="nope/m1", messages=[USER]))
    )

    assert len(events) == 1
    assert isinstance(events[0], LlmStreamFailed)
    assert events[0].error.category is LlmErrorCategory.INVALID_REQUEST
    assert events[0].error.code == "unknown_model"
    assert events[0].error.retryable is False


def test_builtin_catalog_owns_protocol_binding() -> None:
    assert not hasattr(BUILTIN_PROVIDERS[0].models[0], "api")
    assert {provider.api for provider in BUILTIN_PROVIDERS} == {
        ApiKind.OPENAI_COMPLETIONS,
        ApiKind.ANTHROPIC_MESSAGES,
    }
    refs = [model.ref for provider in BUILTIN_PROVIDERS for model in provider.models]
    assert len(refs) == len(set(refs))
