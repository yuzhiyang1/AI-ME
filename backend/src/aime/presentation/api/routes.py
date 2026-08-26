"""AI-ME HTTP 路由。"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, status
from fastapi.responses import StreamingResponse

from aime.application.ports.model_gateway import LlmCompletionRequest, ModelGateway
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
    model_gateway: ModelGateway,
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
        return [ModelResponse.from_domain(model) for model in model_gateway.list_models()]

    @router.post("/chat/completions")
    async def chat_completions(payload: ChatCompletionRequest) -> StreamingResponse:
        """流式补全，以 SSE 返回统一事件。

        Pydantic 类型在本函数内翻译成应用层请求后即消失；
        端口约定请求期错误也走 ERROR 事件，因此本端点恒返回 200。
        已知的分层瑕疵：此处直调端口而非经应用层用例——chat 目前
        没有编排与状态；一旦出现会话管理等逻辑，应补 ChatWithModel
        用例（详见 docs/模型适配层设计.md 的 DDD 立场一节）。
        """
        request = LlmCompletionRequest(
            model_ref=payload.model,
            messages=[message.to_domain() for message in payload.messages],
            system=payload.system,
            max_tokens=payload.max_tokens,
            temperature=payload.temperature,
        )

        async def to_sse() -> AsyncIterator[str]:
            # 每条事件单独 json 并按 SSE 帧格式下发，前端可增量渲染
            async for event in model_gateway.stream(request):
                body = json.dumps({"type": event.type.value, "content": event.content})
                yield f"data: {body}\n\n"

        return StreamingResponse(
            to_sse(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    return router

