"""查询和处理工具审批的应用服务。"""

from uuid import UUID

from aime.application.ports.tool_execution_store import ApprovalBroker, ToolExecutionStore
from aime.domain.tool_execution.entities import ApprovalRequest
from aime.domain.tool_execution.value_objects import ApprovalDecision


class ListPendingApprovals:
    """读取一条 Session 当前等待处理的审批。"""

    def __init__(self, store: ToolExecutionStore) -> None:
        self._store = store

    async def execute(self, session_id: UUID) -> list[ApprovalRequest]:
        return await self._store.list_pending_approvals(session_id)


class DecideApproval:
    """先持久化用户决定，再通知等待中的 Runtime。"""

    def __init__(self, store: ToolExecutionStore, broker: ApprovalBroker) -> None:
        self._store = store
        self._broker = broker

    async def execute(
        self,
        session_id: UUID,
        approval_id: UUID,
        decision: ApprovalDecision,
    ) -> ApprovalRequest:
        resolved = await self._store.resolve_approval(session_id, approval_id, decision)
        self._broker.notify(approval_id, decision)
        return resolved
