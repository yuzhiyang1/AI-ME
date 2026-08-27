"""AI-ME HTTP 路由。"""

import json
from collections.abc import AsyncIterator
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from aime.application.models.services import (
    ListAvailableModels,
    StreamModelCompletion,
    UnknownModelReference,
)
from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamFailed,
    LlmStreamStarted,
    LlmTextDelta,
    LlmThinkingDelta,
    LlmToolCallDelta,
)
from aime.application.work_items.commands import CreateWorkItemCommand
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.presentation.api.schemas import (
    ChatCompletionRequest,
    CreateWorkItemRequest,
    HealthResponse,
    ModelResponse,
    WorkItemResponse,
)


def build_router(
    create_work_item: CreateWorkItem,
    list_work_items: ListWorkItems,
    list_available_models: ListAvailableModels,
    stream_model_completion: StreamModelCompletion,
) -> APIRouter:
    """使用已经装配好的用例创建路由。"""
    router = APIRouter(prefix="/api")

    @router.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", service="ai-me")

    @router.post(
        "/work-items",
        response_model=WorkItemResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create(payload: CreateWorkItemRequest) -> WorkItemResponse:
        item = await create_work_item.execute(CreateWorkItemCommand(title=payload.title))
        return WorkItemResponse.from_domain(item)

    @router.get("/work-items", response_model=list[WorkItemResponse])
    async def list_items() -> list[WorkItemResponse]:
        items = await list_work_items.execute()
        return [WorkItemResponse.from_domain(item) for item in items]

    @router.get("/models", response_model=list[ModelResponse])
    async def list_models() -> list[ModelResponse]:
        """列出当前已配置可用的模型（未配 key 的厂商不会出现）。"""
        return [ModelResponse.from_domain(model) for model in list_available_models.execute()]

    @router.post("/dev/chat/completions")
    async def chat_completions(payload: ChatCompletionRequest) -> StreamingResponse:
        """开发诊断用的原始模型流，不是 AI-ME 的产品对话接口。"""
        request = LlmCompletionRequest(
            model_ref=payload.model,
            messages=[message.to_domain() for message in payload.messages],
            system=payload.system,
            max_tokens=payload.max_tokens,
            temperature=payload.temperature,
        )

        try:
            provider_stream = stream_model_completion.execute(request)
        except UnknownModelReference as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

        async def to_sse() -> AsyncIterator[str]:
            # 每条事件单独 json 并按 SSE 帧格式下发，前端可增量渲染
            async for event in provider_stream:
                body = json.dumps(_event_payload(event), ensure_ascii=False)
                yield f"data: {body}\n\n"

        return StreamingResponse(
            to_sse(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    return router


def _event_payload(event: LlmStreamEvent) -> dict[str, object]:
    """把封闭的 Provider Event 联合类型转换成稳定的 SSE 载荷。"""
    event_types: tuple[tuple[type[object], str], ...] = (
        (LlmStreamStarted, "start"),
        (LlmTextDelta, "text_delta"),
        (LlmThinkingDelta, "thinking_delta"),
        (LlmToolCallDelta, "tool_call_delta"),
        (LlmStreamCompleted, "completed"),
        (LlmStreamFailed, "failed"),
    )
    for event_type, event_name in event_types:
        if isinstance(event, event_type):
            return {"type": event_name, **asdict(event)}
    raise TypeError(f"未知模型流事件：{type(event).__name__}")
