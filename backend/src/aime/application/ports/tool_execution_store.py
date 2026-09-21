"""工具调用账本与用户审批持久化端口。"""

from typing import Protocol
from uuid import UUID

from aime.application.ports.model_gateway import LlmToolCall
from aime.application.ports.tool_execution import (
    ToolDescriptor,
    ToolExecutionContext,
    ToolExecutionResult,
)
from aime.domain.tool_execution.entities import ApprovalRequest, ToolInvocation
from aime.domain.tool_execution.value_objects import ApprovalDecision


class ToolExecutionStore(Protocol):
    """以幂等状态转换维护工具 T1/T2 与审批事实。"""

    async def prepare_invocation(
        self,
        context: ToolExecutionContext,
        call: LlmToolCall,
        descriptor: ToolDescriptor,
        arguments: dict[str, object],
        *,
        step_index: int,
        call_index: int,
        assistant_text: str,
    ) -> ToolInvocation: ...

    async def mark_running(self, invocation_id: UUID) -> ToolInvocation: ...

    async def finish_invocation(
        self,
        invocation_id: UUID,
        result: ToolExecutionResult,
    ) -> ToolInvocation: ...

    async def request_approval(
        self,
        invocation_id: UUID,
        reason: str,
    ) -> ApprovalRequest: ...

    async def has_session_grant(self, session_id: UUID, tool_name: str) -> bool: ...

    async def get_approval_for_invocation(self, invocation_id: UUID) -> ApprovalRequest | None: ...

    async def get_invocation(self, invocation_id: UUID) -> ToolInvocation: ...

    async def list_run_invocations(self, run_id: UUID) -> list[ToolInvocation]: ...

    async def list_session_invocations(self, session_id: UUID) -> list[ToolInvocation]: ...

    async def list_pending_approvals(self, session_id: UUID) -> list[ApprovalRequest]: ...

    async def resolve_approval(
        self,
        session_id: UUID,
        approval_id: UUID,
        decision: ApprovalDecision,
    ) -> ApprovalRequest: ...

    async def recover_unsettled_invocations(self) -> int: ...

    async def cancel_run_approvals(self, run_id: UUID, reason: str) -> int: ...


class ApprovalBroker(Protocol):
    """连接 HTTP 审批决定与正在等待的 Runtime，不保存业务事实。"""

    async def wait(self, approval_id: UUID) -> ApprovalDecision: ...

    def notify(self, approval_id: UUID, decision: ApprovalDecision) -> None: ...
