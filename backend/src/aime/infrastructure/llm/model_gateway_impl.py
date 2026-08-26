"""ModelGateway 端口的实现：按厂商绑定协议并分发调用。

pi 的分层在 Python 里的对应：
catalog（厂商元数据） -> ProviderRuntime（认证 + 协议实例） -> Gateway（分发门面）。
统一消息的协议序列化（如 system 的放置位置）由各协议模块自己完成，
本模块只做“引用解析 -> 找到运行时 -> 转发”。
"""

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from aime.application.ports.model_gateway import (
    ApiKind,
    LlmCompletionRequest,
    ModelDescriptor,
)
from aime.domain.llm.events import LlmStreamEvent
from aime.domain.llm.messages import ConversationMessage
from aime.infrastructure.llm.catalog import BUILTIN_PROVIDERS, ProviderDefinition


class _ProtocolApi(Protocol):
    """协议实现的最小接口（openai_completions / anthropic_messages 都满足）。

    用 Protocol 而不是共同基类，是为了让两个协议模块互不感知，
    也让测试可以用任意满足该签名的假对象注入。
    """

    def stream(
        self,
        model_id: str,
        messages: list[ConversationMessage],
        system: str | None,
        max_tokens: int | None,
        temperature: float | None,
    ) -> AsyncIterator[LlmStreamEvent]: ...


@dataclass(slots=True)
class ProviderRuntime:
    """一个已配置好的厂商运行时。

    definition 提供元数据（模型清单等），api 是持有认证信息的
    协议实例；两者在 build_gateway_from_env 里一次性绑定。
    """

    definition: ProviderDefinition  # 厂商元数据（模型清单等）
    api: _ProtocolApi  # 持有认证信息的协议实例，负责实际调用与翻译


class ProtocolModelGateway:
    """组合内置厂商并按 ``provider/model`` 引用分发的网关实现。"""

    def __init__(self, runtimes: list[ProviderRuntime]) -> None:
        self._runtimes = {runtime.definition.provider: runtime for runtime in runtimes}

    def list_models(self) -> list[ModelDescriptor]:
        """按运行时装配顺序列出所有已配置厂商的模型。"""
        return [model for runtime in self._runtimes.values() for model in runtime.definition.models]

    def resolve(self, model_ref: str) -> tuple[ProviderRuntime, ModelDescriptor] | None:
        """解析 ``provider/model`` 引用；厂商或模型任一未命中返回 None。"""
        provider, _, model_id = model_ref.partition("/")
        runtime = self._runtimes.get(provider)
        if runtime is None:
            return None
        for model in runtime.definition.models:
            if model.model_id == model_id:
                return runtime, model
        return None

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        """转发到对应协议实例；解析失败按端口约定以 ERROR 事件终止。"""
        resolved = self.resolve(request.model_ref)
        if resolved is None:
            yield LlmStreamEvent.error(f"未知模型引用：{request.model_ref}")
            return
        runtime, model = resolved
        stream = runtime.api.stream(
            model.model_id,
            list(request.messages),
            request.system,
            request.max_tokens,
            request.temperature,
        )
        async for event in stream:
            yield event


def build_gateway_from_env(
    providers: tuple[ProviderDefinition, ...] = BUILTIN_PROVIDERS,
) -> ProtocolModelGateway:
    """从环境变量读取各厂商 API key，装配网关。

    没有 key 的厂商不进入运行时（list_models 不会列出）。
    SDK 延迟 import：未配置任何 key 的进程（如跑领域测试）不加载 SDK。
    providers 参数可注入，测试用它装配只含假协议实例的网关。
    """
    from aime.infrastructure.llm.anthropic_messages import build_anthropic_messages_api
    from aime.infrastructure.llm.openai_completions import build_openai_completions_api

    runtimes: list[ProviderRuntime] = []
    for definition in providers:
        api_key = os.environ.get(definition.api_key_env)
        if not api_key:
            continue
        api: _ProtocolApi
        if definition.api is ApiKind.OPENAI_COMPLETIONS:
            api = build_openai_completions_api(api_key, definition.base_url)
        else:
            api = build_anthropic_messages_api(api_key, definition.base_url)
        runtimes.append(ProviderRuntime(definition=definition, api=api))
    return ProtocolModelGateway(runtimes)
