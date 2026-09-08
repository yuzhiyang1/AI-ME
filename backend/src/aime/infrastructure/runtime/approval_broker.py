"""进程内审批唤醒器；SQLite 才是审批事实来源。"""

import asyncio
from uuid import UUID

from aime.application.ports.tool_execution_store import ApprovalBroker
from aime.domain.tool_execution.value_objects import ApprovalDecision


class InMemoryApprovalBroker(ApprovalBroker):
    """让等待审批的 Runtime 在 HTTP 决定提交后立即继续。"""

    def __init__(self) -> None:
        self._waiters: dict[UUID, asyncio.Future[ApprovalDecision]] = {}
        self._early_decisions: dict[UUID, ApprovalDecision] = {}

    async def wait(self, approval_id: UUID) -> ApprovalDecision:
        """等待一次决定；先于 wait 到达的通知也不会丢失。"""
        early = self._early_decisions.pop(approval_id, None)
        if early is not None:
            return early
        loop = asyncio.get_running_loop()
        future = self._waiters.get(approval_id)
        if future is None:
            future = loop.create_future()
            self._waiters[approval_id] = future
        try:
            return await future
        finally:
            self._waiters.pop(approval_id, None)

    def notify(self, approval_id: UUID, decision: ApprovalDecision) -> None:
        """唤醒现有等待者，或缓存提前到达的决定。"""
        future = self._waiters.get(approval_id)
        if future is not None and not future.done():
            future.set_result(decision)
            return
        self._early_decisions[approval_id] = decision
