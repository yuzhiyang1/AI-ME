"""工具调用、审批和恢复使用的状态值。"""

from enum import StrEnum


class ToolInvocationStatus(StrEnum):
    """一次工具调用在持久账本中的生命周期。"""

    PREPARED = "prepared"
    WAITING_FOR_APPROVAL = "waiting_for_approval"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    REJECTED = "rejected"
    UNCERTAIN = "uncertain"


class ApprovalStatus(StrEnum):
    """审批请求是否已经得到用户决定。"""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalDecision(StrEnum):
    """用户可选择的审批决定和生效范围。"""

    APPROVE_ONCE = "approve_once"
    APPROVE_SESSION = "approve_session"
    REJECT = "reject"
