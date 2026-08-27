"""模型目录与开发诊断调用用例。"""

from collections.abc import AsyncIterator

from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmStreamEvent,
    ModelDescriptor,
    ModelGateway,
)


class UnknownModelReference(ValueError):
    """请求引用了当前不可用的模型。"""


class ListAvailableModels:
    """列出已配置、可调用的模型。"""

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway

    def execute(self) -> list[ModelDescriptor]:
        return self._gateway.list_models()


class StreamModelCompletion:
    """仅供开发诊断的原始模型流用例。"""

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway

    def execute(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        # 流响应开始后无法再可靠修改 HTTP 状态，因此在返回迭代器前校验。
        if request.model_ref not in {model.ref for model in self._gateway.list_models()}:
            raise UnknownModelReference(f"未知模型引用：{request.model_ref}")
        return self._gateway.stream(request)
