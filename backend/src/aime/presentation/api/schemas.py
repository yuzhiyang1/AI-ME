"""HTTP 请求与响应结构。"""

from datetime import datetime
from uuid import UUID

from pydantic import AliasGenerator, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from aime.application.ports.model_gateway import ConversationMessage, MessageRole, ModelDescriptor
from aime.domain.sessions.entities import AgentSession, AgentTurn, RuntimeEvent, SessionItem
from aime.domain.sessions.value_objects import (
    PermissionProfile,
    SessionActivity,
    SessionItemStatus,
    SessionItemType,
    SessionLifecycle,
    TurnStatus,
)
from aime.domain.tool_execution.entities import ApprovalRequest, ToolInvocation
from aime.domain.tool_execution.value_objects import ApprovalDecision, ApprovalStatus
from aime.domain.work_items.entities import WorkItem
from aime.domain.work_items.value_objects import WorkItemStatus


class HealthResponse(BaseModel):
    """服务健康状态。"""

    status: str
    service: str


class CreateWorkItemRequest(BaseModel):
    """创建工作事项请求。"""

    title: str = Field(min_length=1, max_length=120)


class ModelResponse(BaseModel):
    """可调用模型的元数据。"""

    ref: str  # 全局引用名 "provider/model_id"，调用时传这个
    provider: str  # 所属厂商 id
    model_id: str  # 厂商侧模型标识
    display_name: str  # 面向用户的显示名
    context_window: int  # 上下文窗口大小（token 数）

    @classmethod
    def from_domain(cls, model: ModelDescriptor) -> "ModelResponse":
        """将模型元数据转换为 HTTP DTO。"""
        return cls(
            ref=model.ref,
            provider=model.provider,
            model_id=model.model_id,
            display_name=model.display_name,
            context_window=model.context_window,
        )


class ChatMessagePayload(BaseModel):
    """HTTP 层的消息载荷。"""

    role: MessageRole  # 消息角色：user / assistant；system 只能用顶层字段传入
    content: str = Field(min_length=1)  # 消息正文，非空

    def to_domain(self) -> ConversationMessage:
        return ConversationMessage(role=self.role, content=self.content)


class ChatCompletionRequest(BaseModel):
    """一次流式补全请求。"""

    model: str  # 目标模型引用，形如 "provider/model_id"，见 ModelDescriptor.ref
    messages: list[ChatMessagePayload] = Field(min_length=1)  # 对话历史，至少一条
    system: str | None = None  # 系统提示词；None 表示不带
    max_tokens: int | None = Field(default=None, gt=0)  # 输出上限（正整数）；None 用协议缺省
    # 采样温度 0.0~2.0；None 用厂商默认
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)


class WorkItemResponse(BaseModel):
    """工作事项响应。"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    status: WorkItemStatus
    created_at: datetime

    @classmethod
    def from_domain(cls, item: WorkItem) -> "WorkItemResponse":
        """将领域对象转换为 HTTP DTO。"""
        return cls(
            id=item.id.value,
            title=item.title.value,
            status=item.status,
            created_at=item.created_at,
        )


class _CamelCaseModel(BaseModel):
    """对外使用 camelCase、Python 内部保持 snake_case 的 DTO 基类。"""

    model_config = ConfigDict(
        alias_generator=AliasGenerator(validation_alias=to_camel, serialization_alias=to_camel),
        populate_by_name=True,
    )


class CreateSessionRequest(_CamelCaseModel):
    """创建一条固定绑定本地工作区的 Agent Session。"""

    workspace_path: str = Field(min_length=1)
    default_model: str = Field(min_length=1, max_length=200)
    permission_profile: PermissionProfile


class SessionResponse(_CamelCaseModel):
    """用户侧稳定的 Session 读取模型。"""

    id: UUID
    title: str
    workspace_path: str
    default_model: str
    permission_profile: PermissionProfile
    lifecycle: SessionLifecycle
    activity: SessionActivity
    pinned: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_domain(cls, session: AgentSession) -> "SessionResponse":
        """把领域 Session 转换为 HTTP DTO。"""
        return cls(
            id=session.id.value,
            title=session.title.value,
            workspace_path=session.workspace_path,
            default_model=session.default_model,
            permission_profile=session.permission_profile,
            lifecycle=session.lifecycle,
            activity=session.activity,
            pinned=session.pinned,
            created_at=session.created_at,
            updated_at=session.updated_at,
        )


class StartTurnRequest(_CamelCaseModel):
    """启动一轮 Agent 工作的用户输入。"""

    input: str = Field(min_length=1)
    client_request_id: str = Field(min_length=1, max_length=120)


class TurnResponse(_CamelCaseModel):
    """Turn 创建后的稳定读取模型。"""

    id: UUID
    session_id: UUID
    status: TurnStatus
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def from_domain(cls, turn: AgentTurn) -> "TurnResponse":
        """把领域 Turn 转换为 HTTP DTO。"""
        return cls(
            id=turn.id.value,
            session_id=turn.session_id.value,
            status=turn.status,
            created_at=turn.created_at,
            started_at=turn.started_at,
            finished_at=turn.finished_at,
        )


class SessionItemResponse(_CamelCaseModel):
    """客户端按 sequence 渲染的一条会话 Item。"""

    id: UUID
    session_id: UUID
    turn_id: UUID
    run_id: UUID | None
    sequence: int
    type: SessionItemType
    status: SessionItemStatus
    content: dict[str, object]
    created_at: datetime

    @classmethod
    def from_domain(cls, item: SessionItem) -> "SessionItemResponse":
        """把领域 Item 转换为 HTTP DTO。"""
        return cls(
            id=item.id.value,
            session_id=item.session_id.value,
            turn_id=item.turn_id.value,
            run_id=item.run_id.value if item.run_id is not None else None,
            sequence=item.sequence,
            type=item.type,
            status=item.status,
            content=item.content,
            created_at=item.created_at,
        )


class RuntimeEventResponse(_CamelCaseModel):
    """SSE 下发的一条可重放 RuntimeEvent。"""

    id: UUID
    session_id: UUID
    turn_id: UUID
    run_id: UUID | None
    sequence: int
    type: str
    payload: dict[str, object]
    created_at: datetime

    @classmethod
    def from_domain(cls, event: RuntimeEvent) -> "RuntimeEventResponse":
        """把领域 RuntimeEvent 转换为对外 DTO。"""
        return cls(
            id=event.id.value,
            session_id=event.session_id.value,
            turn_id=event.turn_id.value,
            run_id=event.run_id.value if event.run_id is not None else None,
            sequence=event.sequence,
            type=event.type,
            payload=event.payload,
            created_at=event.created_at,
        )


class DecideApprovalRequest(_CamelCaseModel):
    """处理危险工具调用的用户决定。"""

    decision: ApprovalDecision


class ApprovalResponse(_CamelCaseModel):
    """客户端展示和处理审批所需的稳定字段。"""

    id: UUID
    session_id: UUID
    turn_id: UUID
    run_id: UUID
    invocation_id: UUID
    tool_name: str
    arguments: dict[str, object]
    reason: str
    status: ApprovalStatus
    decision: ApprovalDecision | None
    requested_at: datetime
    resolved_at: datetime | None

    @classmethod
    def from_domain(cls, approval: ApprovalRequest) -> "ApprovalResponse":
        """把审批领域对象转换为 HTTP DTO。"""
        return cls(
            id=approval.id,
            session_id=approval.session_id,
            turn_id=approval.turn_id,
            run_id=approval.run_id,
            invocation_id=approval.invocation_id,
            tool_name=approval.tool_name,
            arguments=approval.arguments,
            reason=approval.reason,
            status=approval.status,
            decision=approval.decision,
            requested_at=approval.requested_at,
            resolved_at=approval.resolved_at,
        )


class ToolInvocationResponse(_CamelCaseModel):
    """一条可审计工具调用的 T1/T2 读取模型。"""

    id: UUID
    session_id: UUID
    turn_id: UUID
    run_id: UUID
    call_id: str
    step_index: int
    call_index: int
    tool_name: str
    arguments: dict[str, object]
    assistant_text: str
    execution_semantics: str
    risk_level: str
    status: str
    result: dict[str, object] | None
    is_error: bool | None
    prepared_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def from_domain(cls, invocation: ToolInvocation) -> "ToolInvocationResponse":
        """把工具调用领域事实转换为 HTTP DTO。"""
        return cls(
            id=invocation.id,
            session_id=invocation.session_id,
            turn_id=invocation.turn_id,
            run_id=invocation.run_id,
            call_id=invocation.call_id,
            step_index=invocation.step_index,
            call_index=invocation.call_index,
            tool_name=invocation.tool_name,
            arguments=invocation.arguments,
            assistant_text=invocation.assistant_text,
            execution_semantics=invocation.execution_semantics,
            risk_level=invocation.risk_level,
            status=invocation.status.value,
            result=invocation.result,
            is_error=invocation.is_error,
            prepared_at=invocation.prepared_at,
            started_at=invocation.started_at,
            finished_at=invocation.finished_at,
        )
