"""AI-ME HTTP 路由。"""

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import asdict
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse

from aime.application.approvals.exceptions import ApprovalAlreadyResolved, ApprovalNotFound
from aime.application.approvals.services import DecideApproval, ListPendingApprovals
from aime.application.model_configurations.services import (
    ModelConfigurationService,
    ModelCredentialUnavailable,
)
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
from aime.application.sessions.commands import CreateSessionCommand
from aime.application.sessions.exceptions import (
    ActiveTurnConflict,
    IdempotencyConflict,
    TurnNotActive,
)
from aime.application.sessions.services import (
    CreateSession,
    GetSession,
    ListSessions,
    SessionNotFound,
)
from aime.application.sessions.turn_services import (
    GetActiveTurn,
    GetSessionTokenUsage,
    GetTurnByClientRequest,
    InterruptTurn,
    ListRuntimeEvents,
    ListSessionItems,
    StartTurn,
    StartTurnCommand,
)
from aime.application.tools.services import ListToolInvocations
from aime.application.work_items.commands import CreateWorkItemCommand
from aime.application.work_items.services import CreateWorkItem, ListWorkItems
from aime.presentation.api.schemas import (
    ApprovalResponse,
    ChatCompletionRequest,
    CreateModelConfigurationRequest,
    CreateSessionRequest,
    CreateWorkItemRequest,
    DecideApprovalRequest,
    HealthResponse,
    ModelConfigurationResponse,
    ModelResponse,
    RuntimeEventResponse,
    SessionItemResponse,
    SessionResponse,
    SessionTokenUsageResponse,
    StartTurnRequest,
    ToolInvocationResponse,
    TurnResponse,
    WorkItemResponse,
)


def build_router(
    create_work_item: CreateWorkItem,
    list_work_items: ListWorkItems,
    list_available_models: ListAvailableModels,
    stream_model_completion: StreamModelCompletion,
    create_session: CreateSession,
    get_session: GetSession,
    list_sessions: ListSessions,
    start_turn: StartTurn,
    get_active_turn: GetActiveTurn,
    get_turn_by_client_request: GetTurnByClientRequest,
    list_session_items: ListSessionItems,
    list_runtime_events: ListRuntimeEvents,
    get_session_token_usage: GetSessionTokenUsage,
    interrupt_turn: InterruptTurn,
    list_pending_approvals: ListPendingApprovals,
    decide_approval: DecideApproval,
    list_tool_invocations: ListToolInvocations,
    model_configuration_service: ModelConfigurationService,
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

    @router.get(
        "/settings/models",
        response_model=list[ModelConfigurationResponse],
    )
    async def list_model_configurations() -> list[ModelConfigurationResponse]:
        """列出设置页创建的模型配置，响应中永远不包含 API Key。"""
        try:
            views = await model_configuration_service.list()
        except ModelCredentialUnavailable as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        return [ModelConfigurationResponse.from_view(view) for view in views]

    @router.post(
        "/settings/models",
        response_model=ModelConfigurationResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_model_configuration(
        payload: CreateModelConfigurationRequest,
    ) -> ModelConfigurationResponse:
        """安全保存并立即激活用户新增的模型。"""
        try:
            view = await model_configuration_service.create(payload.to_command())
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
        except ModelCredentialUnavailable as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(exc),
            ) from exc
        return ModelConfigurationResponse.from_view(view)

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

    @router.post(
        "/sessions",
        response_model=SessionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_agent_session(payload: CreateSessionRequest) -> SessionResponse:
        """创建一条固定工作区的持久 Agent Session。"""
        try:
            session = await create_session.execute(
                CreateSessionCommand(
                    workspace_path=payload.workspace_path,
                    default_model=payload.default_model,
                    permission_profile=payload.permission_profile,
                )
            )
        except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(exc),
            ) from exc
        return SessionResponse.from_domain(session)

    @router.get("/sessions/{session_id}", response_model=SessionResponse)
    async def get_agent_session(session_id: UUID) -> SessionResponse:
        """读取一条 Session；不存在时返回 404。"""
        try:
            session = await get_session.execute(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return SessionResponse.from_domain(session)

    @router.get("/sessions", response_model=list[SessionResponse])
    async def list_agent_sessions() -> list[SessionResponse]:
        """按最近活动时间返回会话列表。"""
        sessions = await list_sessions.execute()
        return [SessionResponse.from_domain(session) for session in sessions]

    @router.get(
        "/sessions/{session_id}/usage",
        response_model=SessionTokenUsageResponse,
    )
    async def get_agent_session_usage(session_id: UUID) -> SessionTokenUsageResponse:
        """返回可重放的会话 Token 统计；不存在时保持统一 404 语义。"""
        try:
            usage = await get_session_token_usage.execute(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return SessionTokenUsageResponse.from_application(usage)

    @router.post(
        "/sessions/{session_id}/turns",
        response_model=TurnResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def start_agent_turn(session_id: UUID, payload: StartTurnRequest) -> TurnResponse:
        """先持久化用户消息，再异步执行本轮 Agent 工作。"""
        try:
            turn = await start_turn.execute(
                StartTurnCommand(
                    session_id=session_id,
                    instruction=payload.input,
                    client_request_id=payload.client_request_id,
                )
            )
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        except (ActiveTurnConflict, IdempotencyConflict) as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(exc),
            ) from exc
        return TurnResponse.from_domain(turn)

    @router.get(
        "/sessions/{session_id}/turns/active",
        response_model=TurnResponse | None,
    )
    async def get_active_agent_turn(session_id: UUID) -> TurnResponse | None:
        """返回当前活跃 Turn，供页面切换或重载后恢复中断控制。"""
        try:
            turn = await get_active_turn.execute(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return TurnResponse.from_domain(turn) if turn is not None else None

    @router.get(
        "/sessions/{session_id}/turns/by-client-request",
        response_model=TurnResponse | None,
    )
    async def get_turn_by_request_key(
        session_id: UUID,
        client_request_id: str = Query(alias="clientRequestId", min_length=1, max_length=120),
    ) -> TurnResponse | None:
        """按幂等键对账一次结果不确定的 Turn 创建请求。"""
        try:
            turn = await get_turn_by_client_request.execute(session_id, client_request_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return TurnResponse.from_domain(turn) if turn is not None else None

    @router.get(
        "/sessions/{session_id}/items",
        response_model=list[SessionItemResponse],
    )
    async def list_agent_session_items(
        session_id: UUID,
        after_sequence: int = Query(default=0, alias="afterSequence", ge=0),
    ) -> list[SessionItemResponse]:
        """返回游标之后已经持久化的用户侧 Item。"""
        try:
            items = await list_session_items.execute(session_id, after_sequence)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return [SessionItemResponse.from_domain(item) for item in items]

    @router.get("/sessions/{session_id}/events")
    async def stream_agent_session_events(
        session_id: UUID,
        after_sequence: int = Query(default=0, alias="afterSequence", ge=0),
    ) -> StreamingResponse:
        """从游标重放事件，并在活跃 Turn 结束后关闭本次 SSE。"""
        try:
            await get_session.execute(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

        async def to_sse() -> AsyncIterator[str]:
            cursor = after_sequence
            while True:
                events = await list_runtime_events.execute(session_id, cursor)
                for event in events:
                    cursor = event.sequence
                    payload = RuntimeEventResponse.from_domain(event).model_dump(
                        mode="json",
                        by_alias=True,
                    )
                    body = json.dumps(payload, ensure_ascii=False)
                    yield f"id: {event.sequence}\ndata: {body}\n\n"

                session = await get_session.execute(session_id)
                if session.activity.value == "idle":
                    return
                await asyncio.sleep(0.05)

        return StreamingResponse(
            to_sse(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.post(
        "/sessions/{session_id}/turns/{turn_id}/interrupt",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def interrupt_agent_turn(session_id: UUID, turn_id: UUID) -> Response:
        """中断一条仍在本进程执行的 Turn。"""
        try:
            await interrupt_turn.execute(session_id, turn_id)
        except TurnNotActive as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.get(
        "/sessions/{session_id}/approvals",
        response_model=list[ApprovalResponse],
    )
    async def list_agent_approvals(session_id: UUID) -> list[ApprovalResponse]:
        """返回当前等待用户处理的危险工具调用。"""
        try:
            await get_session.execute(session_id)
            approvals = await list_pending_approvals.execute(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        return [ApprovalResponse.from_domain(approval) for approval in approvals]

    @router.post(
        "/sessions/{session_id}/approvals/{approval_id}/decision",
        response_model=ApprovalResponse,
    )
    async def decide_agent_approval(
        session_id: UUID,
        approval_id: UUID,
        payload: DecideApprovalRequest,
    ) -> ApprovalResponse:
        """原子提交一次审批决定并唤醒原 AgentRun。"""
        try:
            approval = await decide_approval.execute(
                session_id,
                approval_id,
                payload.decision,
            )
        except ApprovalNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        except ApprovalAlreadyResolved as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        return ApprovalResponse.from_domain(approval)

    @router.get(
        "/sessions/{session_id}/tool-invocations",
        response_model=list[ToolInvocationResponse],
    )
    async def list_agent_tool_invocations(
        session_id: UUID,
    ) -> list[ToolInvocationResponse]:
        """返回工具 T1/T2 账本，供客户端审计和故障诊断。"""
        try:
            await get_session.execute(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        invocations = await list_tool_invocations.execute(session_id)
        return [ToolInvocationResponse.from_domain(invocation) for invocation in invocations]

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
