"""工具执行与审批账本的 SQLite 实现。"""

import json
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.application.approvals.exceptions import (
    ApprovalAlreadyResolved,
    ApprovalNotFound,
    ToolInvocationNotFound,
)
from aime.application.ports.model_gateway import LlmToolCall
from aime.application.ports.tool_execution import (
    ToolDescriptor,
    ToolExecutionContext,
    ToolExecutionResult,
)
from aime.application.ports.tool_execution_store import ToolExecutionStore
from aime.domain.sessions.value_objects import AgentRunStatus, SessionActivity, TurnStatus
from aime.domain.tool_execution.browser_scope import tool_grant_scope
from aime.domain.tool_execution.entities import ApprovalRequest, ToolInvocation
from aime.domain.tool_execution.value_objects import (
    ApprovalDecision,
    ApprovalStatus,
    ToolInvocationStatus,
)
from aime.infrastructure.persistence.sqlite_database import (
    agent_runs_table,
    approval_grants_table,
    approval_requests_table,
    sessions_table,
    tool_invocations_table,
    turns_table,
)


class SqliteToolExecutionStore(ToolExecutionStore):
    """用数据库约束保证调用准备、结果和审批只能提交一次。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

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
    ) -> ToolInvocation:
        """在任何工具代码运行前提交 T1；重复 call_id 返回相同事实。"""
        invocation_id = uuid4()
        prepared_at = datetime.now(UTC)
        canonical_arguments = _json_dumps(arguments)
        try:
            async with self._session_factory.begin() as database_session:
                await database_session.execute(
                    insert(tool_invocations_table).values(
                        id=str(invocation_id),
                        session_id=context.session_id,
                        turn_id=context.turn_id,
                        run_id=context.run_id,
                        call_id=call.call_id,
                        step_index=step_index,
                        call_index=call_index,
                        tool_name=call.name,
                        arguments_json=canonical_arguments,
                        assistant_text=assistant_text,
                        execution_semantics=descriptor.execution_semantics.value,
                        risk_level=descriptor.risk_level.value,
                        status=ToolInvocationStatus.PREPARED.value,
                        prepared_at=prepared_at,
                    )
                )
        except IntegrityError as exc:
            async with self._session_factory() as database_session:
                row = await _invocation_by_call(
                    database_session, UUID(context.run_id), call.call_id
                )
            if row is None:
                raise
            if (
                row["tool_name"] != call.name
                or row["arguments_json"] != canonical_arguments
                or int(row["step_index"]) != step_index
                or int(row["call_index"]) != call_index
            ):
                raise RuntimeError("同一 Run 的 tool call id 被绑定到不同调用") from exc
            return _invocation_from_row(row)
        return ToolInvocation(
            id=invocation_id,
            session_id=UUID(context.session_id),
            turn_id=UUID(context.turn_id),
            run_id=UUID(context.run_id),
            call_id=call.call_id,
            step_index=step_index,
            call_index=call_index,
            tool_name=call.name,
            arguments=arguments,
            assistant_text=assistant_text,
            execution_semantics=descriptor.execution_semantics.value,
            risk_level=descriptor.risk_level.value,
            status=ToolInvocationStatus.PREPARED,
            result=None,
            is_error=None,
            prepared_at=prepared_at,
            started_at=None,
            finished_at=None,
        )

    async def mark_running(self, invocation_id: UUID) -> ToolInvocation:
        """以 CAS 把 prepared 调用推进到 running。"""
        async with self._session_factory.begin() as database_session:
            now = datetime.now(UTC)
            changed = await database_session.execute(
                update(tool_invocations_table)
                .where(
                    tool_invocations_table.c.id == str(invocation_id),
                    tool_invocations_table.c.status == ToolInvocationStatus.PREPARED.value,
                )
                .values(status=ToolInvocationStatus.RUNNING.value, started_at=now)
            )
            if cast(Any, changed).rowcount != 1:
                row = await _required_invocation(database_session, invocation_id)
                if row["status"] != ToolInvocationStatus.RUNNING.value:
                    raise RuntimeError(f"工具调用不能从 {row['status']} 进入 running")
            row = await _required_invocation(database_session, invocation_id)
        return _invocation_from_row(row)

    async def finish_invocation(
        self,
        invocation_id: UUID,
        result: ToolExecutionResult,
    ) -> ToolInvocation:
        """提交 T2 结果；只有 running 调用可以首次完成。"""
        status = ToolInvocationStatus.FAILED if result.is_error else ToolInvocationStatus.COMPLETED
        async with self._session_factory.begin() as database_session:
            now = datetime.now(UTC)
            changed = await database_session.execute(
                update(tool_invocations_table)
                .where(
                    tool_invocations_table.c.id == str(invocation_id),
                    tool_invocations_table.c.status == ToolInvocationStatus.RUNNING.value,
                )
                .values(
                    status=status.value,
                    result_json=_json_dumps(result.output),
                    is_error=result.is_error,
                    finished_at=now,
                )
            )
            row = await _required_invocation(database_session, invocation_id)
            if cast(Any, changed).rowcount != 1 and row["status"] not in {
                ToolInvocationStatus.COMPLETED.value,
                ToolInvocationStatus.FAILED.value,
            }:
                raise RuntimeError(f"工具调用不能从 {row['status']} 提交结果")
        return _invocation_from_row(row)

    async def request_approval(
        self,
        invocation_id: UUID,
        reason: str,
    ) -> ApprovalRequest:
        """原子创建审批并把调用置为 waiting_for_approval。"""
        try:
            async with self._session_factory.begin() as database_session:
                invocation = await _required_invocation(database_session, invocation_id)
                approval_id = uuid4()
                now = datetime.now(UTC)
                changed = await database_session.execute(
                    update(tool_invocations_table)
                    .where(
                        tool_invocations_table.c.id == str(invocation_id),
                        tool_invocations_table.c.status.in_(
                            [
                                ToolInvocationStatus.PREPARED.value,
                                ToolInvocationStatus.UNCERTAIN.value,
                            ]
                        ),
                    )
                    .values(status=ToolInvocationStatus.WAITING_FOR_APPROVAL.value)
                )
                if cast(Any, changed).rowcount != 1:
                    raise RuntimeError(f"工具调用不能从 {invocation['status']} 请求审批")
                await database_session.execute(
                    insert(approval_requests_table).values(
                        id=str(approval_id),
                        session_id=invocation["session_id"],
                        turn_id=invocation["turn_id"],
                        run_id=invocation["run_id"],
                        invocation_id=str(invocation_id),
                        reason=reason,
                        status=ApprovalStatus.PENDING.value,
                        requested_at=now,
                    )
                )
                # 审批事实和用户侧等待状态必须同事务可见，不能出现“有待办但仍显示运行”。
                await database_session.execute(
                    update(agent_runs_table)
                    .where(agent_runs_table.c.id == invocation["run_id"])
                    .values(status=AgentRunStatus.WAITING_FOR_USER.value)
                )
                await database_session.execute(
                    update(turns_table)
                    .where(turns_table.c.id == invocation["turn_id"])
                    .values(status=TurnStatus.WAITING_FOR_USER.value)
                )
                await database_session.execute(
                    update(sessions_table)
                    .where(sessions_table.c.id == invocation["session_id"])
                    .values(activity=SessionActivity.WAITING_FOR_USER.value, updated_at=now)
                )
                row = await _required_approval(database_session, approval_id)
        except IntegrityError:
            async with self._session_factory() as database_session:
                existing = (
                    (
                        await database_session.execute(
                            select(approval_requests_table).where(
                                approval_requests_table.c.invocation_id == str(invocation_id)
                            )
                        )
                    )
                    .mappings()
                    .one()
                )
            return await self._approval_from_row(existing)
        return await self._approval_from_row(row)

    async def has_session_grant(self, session_id: UUID, tool_name: str) -> bool:
        async with self._session_factory() as database_session:
            row = (
                await database_session.execute(
                    select(approval_grants_table.c.id).where(
                        approval_grants_table.c.session_id == str(session_id),
                        approval_grants_table.c.tool_name == tool_name,
                    )
                )
            ).first()
        return row is not None

    async def get_approval_for_invocation(self, invocation_id: UUID) -> ApprovalRequest | None:
        async with self._session_factory() as database_session:
            row = (
                (
                    await database_session.execute(
                        select(approval_requests_table).where(
                            approval_requests_table.c.invocation_id == str(invocation_id)
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        return await self._approval_from_row(row) if row is not None else None

    async def get_invocation(self, invocation_id: UUID) -> ToolInvocation:
        async with self._session_factory() as database_session:
            row = await _required_invocation(database_session, invocation_id)
        return _invocation_from_row(row)

    async def list_run_invocations(self, run_id: UUID) -> list[ToolInvocation]:
        async with self._session_factory() as database_session:
            rows = (
                await database_session.execute(
                    select(tool_invocations_table)
                    .where(tool_invocations_table.c.run_id == str(run_id))
                    .order_by(
                        tool_invocations_table.c.step_index,
                        tool_invocations_table.c.call_index,
                    )
                )
            ).mappings()
            return [_invocation_from_row(row) for row in rows]

    async def list_session_invocations(self, session_id: UUID) -> list[ToolInvocation]:
        async with self._session_factory() as database_session:
            rows = (
                await database_session.execute(
                    select(tool_invocations_table)
                    .where(tool_invocations_table.c.session_id == str(session_id))
                    .order_by(
                        tool_invocations_table.c.prepared_at,
                        tool_invocations_table.c.step_index,
                        tool_invocations_table.c.call_index,
                    )
                )
            ).mappings()
            return [_invocation_from_row(row) for row in rows]

    async def list_pending_approvals(self, session_id: UUID) -> list[ApprovalRequest]:
        async with self._session_factory() as database_session:
            rows = (
                (
                    await database_session.execute(
                        select(approval_requests_table)
                        .where(
                            approval_requests_table.c.session_id == str(session_id),
                            approval_requests_table.c.status == ApprovalStatus.PENDING.value,
                        )
                        .order_by(approval_requests_table.c.requested_at)
                    )
                )
                .mappings()
                .all()
            )
        return [await self._approval_from_row(row) for row in rows]

    async def resolve_approval(
        self,
        session_id: UUID,
        approval_id: UUID,
        decision: ApprovalDecision,
    ) -> ApprovalRequest:
        """以 CAS 提交用户决定；approve_session 同事务写入会话授权。"""
        async with self._session_factory.begin() as database_session:
            row = await _required_approval(database_session, approval_id)
            if row["session_id"] != str(session_id):
                raise ApprovalNotFound(f"审批不存在：{approval_id}")
            if row["status"] != ApprovalStatus.PENDING.value:
                raise ApprovalAlreadyResolved("审批已经处理，不能重复决定")
            invocation = await _required_invocation(database_session, UUID(row["invocation_id"]))
            now = datetime.now(UTC)
            approval_status = (
                ApprovalStatus.REJECTED
                if decision is ApprovalDecision.REJECT
                else ApprovalStatus.APPROVED
            )
            changed = await database_session.execute(
                update(approval_requests_table)
                .where(
                    approval_requests_table.c.id == str(approval_id),
                    approval_requests_table.c.status == ApprovalStatus.PENDING.value,
                )
                .values(
                    status=approval_status.value,
                    decision=decision.value,
                    resolved_at=now,
                )
            )
            if cast(Any, changed).rowcount != 1:
                raise ApprovalAlreadyResolved("审批已经处理，不能重复决定")
            if decision is ApprovalDecision.REJECT:
                await database_session.execute(
                    update(tool_invocations_table)
                    .where(tool_invocations_table.c.id == row["invocation_id"])
                    .values(
                        status=ToolInvocationStatus.REJECTED.value,
                        result_json=_json_dumps(
                            {"error": {"code": "approval_rejected", "message": "用户拒绝执行"}}
                        ),
                        is_error=True,
                        finished_at=now,
                    )
                )
            else:
                await database_session.execute(
                    update(tool_invocations_table)
                    .where(tool_invocations_table.c.id == row["invocation_id"])
                    .values(status=ToolInvocationStatus.PREPARED.value)
                )
                if decision is ApprovalDecision.APPROVE_SESSION:
                    grant_scope = tool_grant_scope(
                        invocation["tool_name"], json.loads(invocation["arguments_json"])
                    )
                    existing_grant = (
                        await database_session.execute(
                            select(approval_grants_table.c.id).where(
                                approval_grants_table.c.session_id == str(session_id),
                                approval_grants_table.c.tool_name == grant_scope,
                            )
                        )
                    ).first()
                    if existing_grant is None:
                        await database_session.execute(
                            insert(approval_grants_table).values(
                                id=str(uuid4()),
                                session_id=str(session_id),
                                tool_name=grant_scope,
                                approval_id=str(approval_id),
                                created_at=now,
                            )
                        )
            resolved_row = await _required_approval(database_session, approval_id)
        return await self._approval_from_row(resolved_row)

    async def recover_unsettled_invocations(self) -> int:
        """把含工具事实的遗留 Run 转为可恢复等待，缺少 T2 的调用要求人工决策。"""
        async with self._session_factory.begin() as database_session:
            rows = (
                (
                    await database_session.execute(
                        select(tool_invocations_table)
                        .join(
                            agent_runs_table,
                            agent_runs_table.c.id == tool_invocations_table.c.run_id,
                        )
                        .where(
                            agent_runs_table.c.status.in_(
                                [AgentRunStatus.CREATED.value, AgentRunStatus.RUNNING.value]
                            ),
                            agent_runs_table.c.terminal_event_id.is_(None),
                        )
                    )
                )
                .mappings()
                .all()
            )
            if not rows:
                return 0
            now = datetime.now(UTC)
            recovered_run_ids: set[str] = set()
            for row in rows:
                run_id = str(row["run_id"])
                recovered_run_ids.add(run_id)
                if row["status"] == ToolInvocationStatus.RUNNING.value:
                    approval_id = uuid4()
                    await database_session.execute(
                        update(tool_invocations_table)
                        .where(tool_invocations_table.c.id == row["id"])
                        .values(status=ToolInvocationStatus.WAITING_FOR_APPROVAL.value)
                    )
                    await database_session.execute(
                        insert(approval_requests_table).values(
                            id=str(approval_id),
                            session_id=row["session_id"],
                            turn_id=row["turn_id"],
                            run_id=run_id,
                            invocation_id=row["id"],
                            reason=(
                                "应用上次退出时工具已经开始，但缺少完成记录，"
                                "无法确认副作用是否发生。批准将重新执行，拒绝将把本次调用作为错误回填模型。"
                            ),
                            status=ApprovalStatus.PENDING.value,
                            requested_at=now,
                        )
                    )
                await database_session.execute(
                    update(agent_runs_table)
                    .where(agent_runs_table.c.id == run_id)
                    .values(status=AgentRunStatus.WAITING_FOR_USER.value)
                )
                await database_session.execute(
                    update(turns_table)
                    .where(turns_table.c.id == row["turn_id"])
                    .values(status=TurnStatus.WAITING_FOR_USER.value)
                )
                await database_session.execute(
                    update(sessions_table)
                    .where(sessions_table.c.id == row["session_id"])
                    .values(activity=SessionActivity.WAITING_FOR_USER.value, updated_at=now)
                )
        return len(recovered_run_ids)

    async def cancel_run_approvals(self, run_id: UUID, reason: str) -> int:
        """Run 被用户中断时关闭所有待审批，防止终态后仍可批准。"""
        async with self._session_factory.begin() as database_session:
            rows = (
                (
                    await database_session.execute(
                        select(approval_requests_table).where(
                            approval_requests_table.c.run_id == str(run_id),
                            approval_requests_table.c.status == ApprovalStatus.PENDING.value,
                        )
                    )
                )
                .mappings()
                .all()
            )
            now = datetime.now(UTC)
            for row in rows:
                await database_session.execute(
                    update(approval_requests_table)
                    .where(approval_requests_table.c.id == row["id"])
                    .values(status=ApprovalStatus.REJECTED.value, resolved_at=now)
                )
                await database_session.execute(
                    update(tool_invocations_table)
                    .where(tool_invocations_table.c.id == row["invocation_id"])
                    .values(
                        status=ToolInvocationStatus.REJECTED.value,
                        result_json=_json_dumps(
                            {"error": {"code": "run_interrupted", "message": reason}}
                        ),
                        is_error=True,
                        finished_at=now,
                    )
                )
        return len(rows)

    async def _approval_from_row(self, row: RowMapping) -> ApprovalRequest:
        async with self._session_factory() as database_session:
            invocation = await _required_invocation(
                database_session, UUID(str(row["invocation_id"]))
            )
        return ApprovalRequest(
            id=UUID(str(row["id"])),
            session_id=UUID(str(row["session_id"])),
            turn_id=UUID(str(row["turn_id"])),
            run_id=UUID(str(row["run_id"])),
            invocation_id=UUID(str(row["invocation_id"])),
            tool_name=str(invocation["tool_name"]),
            arguments=json.loads(invocation["arguments_json"]),
            reason=str(row["reason"]),
            status=ApprovalStatus(str(row["status"])),
            decision=(
                ApprovalDecision(str(row["decision"])) if row["decision"] is not None else None
            ),
            requested_at=row["requested_at"],
            resolved_at=row["resolved_at"],
        )


async def _invocation_by_call(
    database_session: AsyncSession, run_id: UUID, call_id: str
) -> RowMapping | None:
    return (
        (
            await database_session.execute(
                select(tool_invocations_table).where(
                    tool_invocations_table.c.run_id == str(run_id),
                    tool_invocations_table.c.call_id == call_id,
                )
            )
        )
        .mappings()
        .one_or_none()
    )


async def _required_invocation(database_session: AsyncSession, invocation_id: UUID) -> RowMapping:
    row = (
        (
            await database_session.execute(
                select(tool_invocations_table).where(
                    tool_invocations_table.c.id == str(invocation_id)
                )
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ToolInvocationNotFound(f"工具调用不存在：{invocation_id}")
    return row


async def _required_approval(database_session: AsyncSession, approval_id: UUID) -> RowMapping:
    row = (
        (
            await database_session.execute(
                select(approval_requests_table).where(
                    approval_requests_table.c.id == str(approval_id)
                )
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ApprovalNotFound(f"审批不存在：{approval_id}")
    return row


def _invocation_from_row(row: RowMapping) -> ToolInvocation:
    result_json = row["result_json"]
    return ToolInvocation(
        id=UUID(str(row["id"])),
        session_id=UUID(str(row["session_id"])),
        turn_id=UUID(str(row["turn_id"])),
        run_id=UUID(str(row["run_id"])),
        call_id=str(row["call_id"]),
        step_index=int(row["step_index"]),
        call_index=int(row["call_index"]),
        tool_name=str(row["tool_name"]),
        arguments=json.loads(row["arguments_json"]),
        assistant_text=str(row["assistant_text"]),
        execution_semantics=str(row["execution_semantics"]),
        risk_level=str(row["risk_level"]),
        status=ToolInvocationStatus(str(row["status"])),
        result=json.loads(result_json) if result_json is not None else None,
        is_error=bool(row["is_error"]) if row["is_error"] is not None else None,
        prepared_at=row["prepared_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


def _json_dumps(value: dict[str, object]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
