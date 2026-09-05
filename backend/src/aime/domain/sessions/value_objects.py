"""Agent Session 值对象与状态枚举。"""

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID


@dataclass(frozen=True, slots=True)
class SessionId:
    """Session 的稳定标识。"""

    value: UUID


@dataclass(frozen=True, slots=True)
class SessionTitle:
    """用户可见的 Session 标题。"""

    value: str

    def __post_init__(self) -> None:
        normalized = self.value.strip()
        if not normalized:
            raise ValueError("Session 标题不能为空")
        if len(normalized) > 120:
            raise ValueError("Session 标题不能超过 120 个字符")
        object.__setattr__(self, "value", normalized)


class SessionLifecycle(StrEnum):
    """Session 是否仍处于可继续使用的生命周期。"""

    ACTIVE = "active"
    ARCHIVED = "archived"


class SessionActivity(StrEnum):
    """Session 当前是否正在执行或等待交互。"""

    IDLE = "idle"
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"


class PermissionProfile(StrEnum):
    """Session 使用的工作区权限档位。"""

    READ_ONLY = "read_only"
    WORKSPACE_WRITE = "workspace_write"
    FULL_ACCESS = "full_access"


@dataclass(frozen=True, slots=True)
class TurnId:
    """Turn 的稳定标识。"""

    value: UUID


@dataclass(frozen=True, slots=True)
class AgentRunId:
    """一次 Agent 执行尝试的稳定标识。"""

    value: UUID


@dataclass(frozen=True, slots=True)
class SessionItemId:
    """用户侧 Item 的稳定标识。"""

    value: UUID


@dataclass(frozen=True, slots=True)
class RuntimeEventId:
    """持久 RuntimeEvent 的稳定标识。"""

    value: UUID


class TurnStatus(StrEnum):
    """一次用户请求及其 Agent 工作的生命周期。"""

    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    WAITING_FOR_USER = "waiting_for_user"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class AgentRunStatus(StrEnum):
    """一次具体执行尝试的内部生命周期。"""

    CREATED = "created"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class SessionItemType(StrEnum):
    """客户端可稳定渲染的会话 Item 类型。"""

    USER_MESSAGE = "user_message"
    AGENT_MESSAGE = "agent_message"
    ERROR = "error"


class SessionItemStatus(StrEnum):
    """Item 是否仍在流式生成。"""

    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
