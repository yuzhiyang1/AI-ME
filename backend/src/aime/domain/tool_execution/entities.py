"""可审计的工具调用与审批实体。"""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from aime.domain.tool_execution.value_objects import (
    ApprovalDecision,
    ApprovalStatus,
    ToolInvocationStatus,
)


@dataclass(frozen=True, slots=True)
class ToolInvocation:
    """一次模型工具调用的 T1/T2 持久事实。"""

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
    status: ToolInvocationStatus
    result: dict[str, object] | None
    is_error: bool | None
    prepared_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """一个等待用户确认的危险工具调用。"""

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
