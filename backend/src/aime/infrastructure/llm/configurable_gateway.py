"""把设置页模型动态叠加到已有环境变量模型网关。"""

from collections.abc import AsyncIterator
from dataclasses import dataclass

from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmStreamEvent,
    ModelDescriptor,
    ModelGateway,
)
from aime.domain.model_configurations.entities import ModelConfiguration, ModelProtocol
from aime.infrastructure.llm.anthropic_messages import build_anthropic_messages_api
from aime.infrastructure.llm.model_gateway_impl import _ProtocolApi
from aime.infrastructure.llm.openai_completions import build_openai_completions_api


@dataclass(slots=True)
class _ConfiguredRuntime:
    """一个模型配置对应的协议客户端。"""

    descriptor: ModelDescriptor
    api: _ProtocolApi


class ConfigurableModelGateway:
    """优先路由设置页模型，其余调用转发给原模型网关。"""

    def __init__(self, fallback: ModelGateway) -> None:
        self._fallback = fallback
        self._configured: dict[str, _ConfiguredRuntime] = {}

    def activate(self, configuration: ModelConfiguration, api_key: str) -> None:
        """创建协议客户端并立即注册，过程中不发起网络请求。"""
        api: _ProtocolApi
        if configuration.protocol is ModelProtocol.OPENAI_COMPLETIONS:
            api = build_openai_completions_api(api_key, configuration.base_url)
        elif configuration.protocol is ModelProtocol.ANTHROPIC_MESSAGES:
            api = build_anthropic_messages_api(api_key, configuration.base_url)
        else:
            raise ValueError(f"不支持的模型协议：{configuration.protocol}")
        descriptor = ModelDescriptor(
            provider=configuration.provider,
            model_id=configuration.model_id,
            display_name=configuration.display_name,
            context_window=configuration.context_window,
        )
        self._configured[descriptor.ref] = _ConfiguredRuntime(descriptor, api)

    def deactivate(self, model_ref: str) -> None:
        """撤销一次未能完整保存的运行时注册。"""
        self._configured.pop(model_ref, None)

    def list_models(self) -> list[ModelDescriptor]:
        """设置页配置覆盖同引用环境配置，避免模型列表出现重复项。"""
        configured_refs = set(self._configured)
        fallback_models = [
            model for model in self._fallback.list_models() if model.ref not in configured_refs
        ]
        return [*fallback_models, *(item.descriptor for item in self._configured.values())]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        runtime = self._configured.get(request.model_ref)
        if runtime is None:
            async for event in self._fallback.stream(request):
                yield event
            return
        stream = runtime.api.stream(
            runtime.descriptor.model_id,
            list(request.messages),
            request.system,
            request.max_tokens,
            request.temperature,
            list(request.tools),
            request.parallel_tool_calls,
        )
        async for event in stream:
            yield event
