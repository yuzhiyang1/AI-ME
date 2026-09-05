"""消费 ModelGateway 的文本版 Agent Runtime。"""

from collections.abc import AsyncIterator

from aime.application.ports.agent_runtime import AgentEvent, AgentRunRequest, AgentRuntime
from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmStreamFailed,
    LlmTextDelta,
    ModelGateway,
)


class ModelAgentRuntime(AgentRuntime):
    """第一条纵向切片使用的文本 Runtime；后续在此加入工具循环。"""

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway

    async def run(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        """流式调用模型，并只暴露 Runtime 能理解的标准事件。"""
        provider_stream = self._gateway.stream(
            LlmCompletionRequest(model_ref=request.model_ref, messages=request.messages)
        )
        async for event in provider_stream:
            if isinstance(event, LlmTextDelta):
                yield AgentEvent(type="text_delta", content=event.delta)
            elif isinstance(event, LlmStreamFailed):
                yield AgentEvent(type="failed", content=event.error.message)
                return
