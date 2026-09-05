"""Agent Session 聚合。"""

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from aime.domain.sessions.value_objects import (
    AgentRunId,
    AgentRunStatus,
    PermissionProfile,
    RuntimeEventId,
    SessionActivity,
    SessionId,
    SessionItemId,
    SessionItemStatus,
    SessionItemType,
    SessionLifecycle,
    SessionTitle,
    TurnId,
    TurnStatus,
)


@dataclass(slots=True)
class AgentSession:
    """一条可以持续多轮协作、并固定绑定工作区的任务会话。"""

    id: SessionId
    title: SessionTitle
    workspace_path: str
    default_model: str
    permission_profile: PermissionProfile
    lifecycle: SessionLifecycle
    activity: SessionActivity
    pinned: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def create(
        cls,
        *,
        workspace_path: str,
        default_model: str,
        permission_profile: PermissionProfile,
    ) -> "AgentSession":
        """创建一条默认空闲、未置顶的 Session。"""
        now = datetime.now(UTC)
        return cls(
            id=SessionId(uuid4()),
            title=SessionTitle("新任务"),
            workspace_path=workspace_path,
            default_model=default_model,
            permission_profile=permission_profile,
            lifecycle=SessionLifecycle.ACTIVE,
            activity=SessionActivity.IDLE,
            pinned=False,
            created_at=now,
            updated_at=now,
        )


@dataclass(slots=True)
class AgentTurn:
    """用户的一次请求及其后续 Agent 工作。"""

    id: TurnId
    session_id: SessionId
    status: TurnStatus
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(slots=True)
class AgentRun:
    """同一 Turn 下的一次具体执行尝试。"""

    id: AgentRunId
    session_id: SessionId
    turn_id: TurnId
    attempt: int
    status: AgentRunStatus
    model_ref: str
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(slots=True)
class SessionItem:
    """按 Session sequence 排序的用户侧会话事实。"""

    id: SessionItemId
    session_id: SessionId
    turn_id: TurnId
    run_id: AgentRunId | None
    sequence: int
    type: SessionItemType
    status: SessionItemStatus
    content: dict[str, object]
    created_at: datetime


@dataclass(slots=True)
class RuntimeEvent:
    """一次 AgentRun 产生的不可变、有序运行事实。"""

    id: RuntimeEventId
    session_id: SessionId
    turn_id: TurnId
    run_id: AgentRunId | None
    sequence: int
    type: str
    payload: dict[str, object]
    created_at: datetime
