"""Turn、AgentRun、RuntimeEvent 与 Item 的 SQLite 持久化实现。"""

import json
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.application.ports.conversation_store import (
    ConversationStore,
    SessionTokenUsage,
    TurnExecution,
)
from aime.application.ports.model_gateway import ConversationMessage, MessageRole
from aime.application.sessions.exceptions import ActiveTurnConflict, IdempotencyConflict
from aime.application.sessions.services import SessionNotFound
from aime.domain.sessions.entities import AgentRun, AgentTurn, RuntimeEvent, SessionItem
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
    TurnId,
    TurnStatus,
)
from aime.infrastructure.persistence.sqlite_database import (
    agent_runs_table,
    runtime_events_table,
    session_items_table,
    session_workspace_roots_table,
    sessions_table,
    turns_table,
)


class SqliteConversationStore(ConversationStore):
    """用 SQLite 事务维护会话语义事实和读取投影。"""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def start_turn(
        self,
        *,
        session_id: UUID,
        instruction: str,
        client_request_id: str,
    ) -> TurnExecution:
        """创建 Turn，并把数据库唯一约束冲突翻译成稳定应用语义。"""
        try:
            return await self._start_turn_once(
                session_id=session_id,
                instruction=instruction,
                client_request_id=client_request_id,
            )
        except IntegrityError as exc:
            # 两个请求同时通过前置查询时，由数据库约束决定胜者，再读取最终事实。
            async with self._session_factory() as database_session:
                existing = (
                    (
                        await database_session.execute(
                            select(turns_table).where(
                                turns_table.c.session_id == str(session_id),
                                turns_table.c.client_request_id == client_request_id,
                            )
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if existing is not None:
                    return await self._existing_execution(database_session, existing, instruction)
                active = (
                    await database_session.execute(
                        select(turns_table.c.id).where(
                            turns_table.c.session_id == str(session_id),
                            turns_table.c.status.in_(
                                [
                                    TurnStatus.QUEUED.value,
                                    TurnStatus.IN_PROGRESS.value,
                                    TurnStatus.WAITING_FOR_USER.value,
                                ]
                            ),
                        )
                    )
                ).first()
            if active is not None:
                raise ActiveTurnConflict("Session 已有正在执行的 Turn") from exc
            raise

    async def _start_turn_once(
        self,
        *,
        session_id: UUID,
        instruction: str,
        client_request_id: str,
    ) -> TurnExecution:
        """原子创建 Turn、首个 AgentRun 与用户消息事实。"""
        async with self._session_factory.begin() as database_session:
            session_row = await _session_row(database_session, session_id)
            if session_row is None:
                raise SessionNotFound(f"Session 不存在：{session_id}")

            existing = (
                (
                    await database_session.execute(
                        select(turns_table).where(
                            turns_table.c.session_id == str(session_id),
                            turns_table.c.client_request_id == client_request_id,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
            if existing is not None:
                return await self._existing_execution(database_session, existing, instruction)

            active = (
                await database_session.execute(
                    select(turns_table.c.id).where(
                        turns_table.c.session_id == str(session_id),
                        turns_table.c.status.in_(
                            [
                                TurnStatus.QUEUED.value,
                                TurnStatus.IN_PROGRESS.value,
                                TurnStatus.WAITING_FOR_USER.value,
                            ]
                        ),
                    )
                )
            ).first()
            if active is not None:
                raise ActiveTurnConflict("Session 已有正在执行的 Turn")

            now = datetime.now(UTC)
            turn_id = uuid4()
            run_id = uuid4()
            event_id = uuid4()
            item_id = uuid4()
            sequence = int(session_row["last_event_sequence"]) + 1
            model_ref = str(session_row["default_model"])

            await database_session.execute(
                insert(turns_table).values(
                    id=str(turn_id),
                    session_id=str(session_id),
                    status=TurnStatus.QUEUED.value,
                    client_request_id=client_request_id,
                    created_at=now,
                    started_at=None,
                )
            )
            await database_session.execute(
                insert(agent_runs_table).values(
                    id=str(run_id),
                    session_id=str(session_id),
                    turn_id=str(turn_id),
                    attempt=1,
                    status=AgentRunStatus.CREATED.value,
                    model_ref=model_ref,
                    started_at=None,
                )
            )
            payload: dict[str, object] = {"text": instruction}
            await _append_event_and_item(
                database_session,
                event_id=event_id,
                item_id=item_id,
                session_id=session_id,
                turn_id=turn_id,
                run_id=run_id,
                sequence=sequence,
                event_type=SessionItemType.USER_MESSAGE.value,
                item_type=SessionItemType.USER_MESSAGE,
                item_status=SessionItemStatus.COMPLETED,
                payload=payload,
                created_at=now,
            )
            await database_session.execute(
                update(sessions_table)
                .where(sessions_table.c.id == str(session_id))
                .values(
                    title=(
                        _default_title(instruction)
                        if session_row["title"] == "新任务"
                        else session_row["title"]
                    ),
                    activity=SessionActivity.QUEUED.value,
                    updated_at=now,
                    last_event_sequence=sequence,
                )
            )

            messages = await _model_messages(database_session, session_id)
            turn = AgentTurn(
                id=TurnId(turn_id),
                session_id=SessionId(session_id),
                status=TurnStatus.QUEUED,
                created_at=now,
                started_at=None,
                finished_at=None,
            )
            run = AgentRun(
                id=AgentRunId(run_id),
                session_id=SessionId(session_id),
                turn_id=TurnId(turn_id),
                attempt=1,
                status=AgentRunStatus.CREATED,
                model_ref=model_ref,
                started_at=None,
                finished_at=None,
            )
            return TurnExecution(
                turn,
                run,
                instruction,
                tuple(messages),
                True,
                workspace_path=str(session_row["workspace_path"]),
                permission_profile=PermissionProfile(str(session_row["permission_profile"])),
                workspace_roots=await _session_workspace_roots(
                    database_session,
                    session_id,
                    fallback=str(session_row["workspace_path"]),
                ),
            )

    async def mark_run_started(self, execution: TurnExecution) -> bool:
        """拿到全局并发名额后，原子把排队执行推进到 running。"""
        async with self._session_factory.begin() as database_session:
            now = datetime.now(UTC)
            claimed = await database_session.execute(
                update(agent_runs_table)
                .where(
                    agent_runs_table.c.id == str(execution.run.id.value),
                    agent_runs_table.c.status == AgentRunStatus.CREATED.value,
                    agent_runs_table.c.terminal_event_id.is_(None),
                )
                .values(status=AgentRunStatus.RUNNING.value, started_at=now)
            )
            if cast(Any, claimed).rowcount != 1:
                return False
            started_turn = await database_session.execute(
                update(turns_table)
                .where(
                    turns_table.c.id == str(execution.turn.id.value),
                    turns_table.c.status == TurnStatus.QUEUED.value,
                )
                .values(status=TurnStatus.IN_PROGRESS.value, started_at=now)
            )
            if cast(Any, started_turn).rowcount != 1:
                raise RuntimeError("AgentRun 与 Turn 状态不一致，启动操作已回滚")
            await database_session.execute(
                update(sessions_table)
                .where(sessions_table.c.id == str(execution.run.session_id.value))
                .values(activity=SessionActivity.RUNNING.value, updated_at=now)
            )
        return True

    async def complete_run(self, execution: TurnExecution, response_text: str) -> bool:
        """用单一 CAS 事务提交回答和 completed 终态。"""
        return await self._commit_terminal(
            execution,
            run_status=AgentRunStatus.COMPLETED,
            turn_status=TurnStatus.COMPLETED,
            item_type=SessionItemType.AGENT_MESSAGE,
            item_status=SessionItemStatus.COMPLETED,
            item_payload={"text": response_text},
        )

    async def mark_run_waiting(self, execution: TurnExecution) -> bool:
        """工具需要审批时，把 Run、Turn 和 Session 原子置为等待用户。"""
        async with self._session_factory.begin() as database_session:
            now = datetime.now(UTC)
            changed = await database_session.execute(
                update(agent_runs_table)
                .where(
                    agent_runs_table.c.id == str(execution.run.id.value),
                    agent_runs_table.c.status == AgentRunStatus.RUNNING.value,
                    agent_runs_table.c.terminal_event_id.is_(None),
                )
                .values(status=AgentRunStatus.WAITING_FOR_USER.value)
            )
            if cast(Any, changed).rowcount != 1:
                current = (
                    await database_session.execute(
                        select(agent_runs_table.c.status).where(
                            agent_runs_table.c.id == str(execution.run.id.value)
                        )
                    )
                ).scalar_one_or_none()
                return current == AgentRunStatus.WAITING_FOR_USER.value
            await database_session.execute(
                update(turns_table)
                .where(turns_table.c.id == str(execution.turn.id.value))
                .values(status=TurnStatus.WAITING_FOR_USER.value)
            )
            await database_session.execute(
                update(sessions_table)
                .where(sessions_table.c.id == str(execution.run.session_id.value))
                .values(activity=SessionActivity.WAITING_FOR_USER.value, updated_at=now)
            )
        return True

    async def mark_run_resumed(self, execution: TurnExecution) -> bool:
        """审批完成并重新取得并发名额后恢复运行状态。"""
        async with self._session_factory.begin() as database_session:
            now = datetime.now(UTC)
            changed = await database_session.execute(
                update(agent_runs_table)
                .where(
                    agent_runs_table.c.id == str(execution.run.id.value),
                    agent_runs_table.c.status == AgentRunStatus.WAITING_FOR_USER.value,
                    agent_runs_table.c.terminal_event_id.is_(None),
                )
                .values(status=AgentRunStatus.RUNNING.value)
            )
            if cast(Any, changed).rowcount != 1:
                return False
            await database_session.execute(
                update(turns_table)
                .where(turns_table.c.id == str(execution.turn.id.value))
                .values(status=TurnStatus.IN_PROGRESS.value)
            )
            await database_session.execute(
                update(sessions_table)
                .where(sessions_table.c.id == str(execution.run.session_id.value))
                .values(activity=SessionActivity.RUNNING.value, updated_at=now)
            )
        return True

    async def append_run_event(
        self,
        execution: TurnExecution,
        event_type: str,
        payload: dict[str, object],
    ) -> RuntimeEvent:
        """为活跃 Run 追加一条有序事实，供断线重放与调试。"""
        async with self._session_factory.begin() as database_session:
            run_row = (
                await database_session.execute(
                    select(agent_runs_table.c.status, agent_runs_table.c.terminal_event_id).where(
                        agent_runs_table.c.id == str(execution.run.id.value)
                    )
                )
            ).one_or_none()
            if (
                run_row is None
                or run_row.status
                not in {
                    AgentRunStatus.RUNNING.value,
                    AgentRunStatus.WAITING_FOR_USER.value,
                }
                or run_row.terminal_event_id is not None
            ):
                raise RuntimeError("不能为已经结束的 AgentRun 追加事件")
            session_row = await _required_session_row(
                database_session,
                execution.run.session_id.value,
            )
            event_id = uuid4()
            sequence = int(session_row["last_event_sequence"]) + 1
            created_at = datetime.now(UTC)
            await _append_event(
                database_session,
                event_id=event_id,
                session_id=execution.run.session_id.value,
                turn_id=execution.turn.id.value,
                run_id=execution.run.id.value,
                sequence=sequence,
                event_type=event_type,
                payload=payload,
                created_at=created_at,
            )
            await database_session.execute(
                update(sessions_table)
                .where(sessions_table.c.id == str(execution.run.session_id.value))
                .values(updated_at=created_at, last_event_sequence=sequence)
            )
        return RuntimeEvent(
            id=RuntimeEventId(event_id),
            session_id=execution.run.session_id,
            turn_id=execution.turn.id,
            run_id=execution.run.id,
            sequence=sequence,
            type=event_type,
            payload=payload,
            created_at=created_at,
        )

    async def fail_run(self, execution: TurnExecution, message: str) -> bool:
        """记录用户可见错误，并把 Run 收敛为 failed。"""
        return await self._commit_terminal(
            execution,
            run_status=AgentRunStatus.FAILED,
            turn_status=TurnStatus.FAILED,
            item_type=SessionItemType.ERROR,
            item_status=SessionItemStatus.FAILED,
            item_payload={"message": message},
        )

    async def interrupt_run(self, execution: TurnExecution) -> bool:
        """把被进程关闭取消的执行收敛为 interrupted。"""
        return await self._commit_terminal(
            execution,
            run_status=AgentRunStatus.INTERRUPTED,
            turn_status=TurnStatus.INTERRUPTED,
            item_type=SessionItemType.ERROR,
            item_status=SessionItemStatus.FAILED,
            item_payload={"message": "执行已中断"},
        )

    async def recover_incomplete_runs(self) -> int:
        """启动时把没有 terminal fact 的遗留 Run 收敛为 interrupted。"""
        async with self._session_factory() as database_session:
            run_rows = (
                (
                    await database_session.execute(
                        select(agent_runs_table).where(
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
            executions: list[TurnExecution] = []
            for run_row in run_rows:
                turn_row = (
                    (
                        await database_session.execute(
                            select(turns_table).where(turns_table.c.id == run_row["turn_id"])
                        )
                    )
                    .mappings()
                    .one()
                )
                executions.append(
                    TurnExecution(
                        turn=_turn_from_row(turn_row),
                        run=_run_from_row(run_row),
                        instruction="",
                        messages=(),
                        newly_created=False,
                    )
                )

        recovered = 0
        for execution in executions:
            committed = await self._commit_terminal(
                execution,
                run_status=AgentRunStatus.INTERRUPTED,
                turn_status=TurnStatus.INTERRUPTED,
                item_type=SessionItemType.ERROR,
                item_status=SessionItemStatus.FAILED,
                item_payload={"message": "上次运行因应用异常退出而中断"},
            )
            recovered += int(committed)
        return recovered

    async def get_active_turn(self, session_id: UUID) -> AgentTurn | None:
        """读取 Session 当前排队、运行中或等待用户的 Turn。"""
        async with self._session_factory() as database_session:
            await _required_session_row(database_session, session_id)
            row = (
                (
                    await database_session.execute(
                        select(turns_table)
                        .where(
                            turns_table.c.session_id == str(session_id),
                            turns_table.c.status.in_(
                                [
                                    TurnStatus.QUEUED.value,
                                    TurnStatus.IN_PROGRESS.value,
                                    TurnStatus.WAITING_FOR_USER.value,
                                ]
                            ),
                        )
                        .order_by(turns_table.c.created_at.desc())
                        .limit(1)
                    )
                )
                .mappings()
                .one_or_none()
            )
        return _turn_from_row(row) if row is not None else None

    async def list_resumable_executions(self) -> list[TurnExecution]:
        """重建等待审批的执行，让新进程继续同一个 Run。"""
        async with self._session_factory() as database_session:
            run_rows = (
                (
                    await database_session.execute(
                        select(agent_runs_table).where(
                            agent_runs_table.c.status == AgentRunStatus.WAITING_FOR_USER.value,
                            agent_runs_table.c.terminal_event_id.is_(None),
                        )
                    )
                )
                .mappings()
                .all()
            )
            executions: list[TurnExecution] = []
            for run_row in run_rows:
                turn_row = (
                    (
                        await database_session.execute(
                            select(turns_table).where(turns_table.c.id == run_row["turn_id"])
                        )
                    )
                    .mappings()
                    .one()
                )
                session_row = await _required_session_row(
                    database_session, UUID(str(run_row["session_id"]))
                )
                user_item = (
                    await database_session.execute(
                        select(session_items_table.c.content_json).where(
                            session_items_table.c.turn_id == turn_row["id"],
                            session_items_table.c.type == SessionItemType.USER_MESSAGE.value,
                        )
                    )
                ).one()
                session_id = UUID(str(run_row["session_id"]))
                messages = await _model_messages(database_session, session_id)
                executions.append(
                    TurnExecution(
                        turn=_turn_from_row(turn_row),
                        run=_run_from_row(run_row),
                        instruction=str(json.loads(user_item.content_json)["text"]),
                        messages=tuple(messages),
                        newly_created=False,
                        workspace_path=str(session_row["workspace_path"]),
                        permission_profile=PermissionProfile(
                            str(session_row["permission_profile"])
                        ),
                        workspace_roots=await _session_workspace_roots(
                            database_session,
                            session_id,
                            fallback=str(session_row["workspace_path"]),
                        ),
                    )
                )
        return executions

    async def get_turn_by_client_request(
        self,
        session_id: UUID,
        client_request_id: str,
    ) -> AgentTurn | None:
        """按 Session 内幂等键读取 Turn，供客户端处理未知 POST 结果。"""
        async with self._session_factory() as database_session:
            await _required_session_row(database_session, session_id)
            row = (
                (
                    await database_session.execute(
                        select(turns_table).where(
                            turns_table.c.session_id == str(session_id),
                            turns_table.c.client_request_id == client_request_id,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        return _turn_from_row(row) if row is not None else None

    async def list_items(self, session_id: UUID, after_sequence: int = 0) -> list[SessionItem]:
        """按稳定 sequence 返回客户端投影。"""
        async with self._session_factory() as database_session:
            await _required_session_row(database_session, session_id)
            rows = (
                await database_session.execute(
                    select(session_items_table)
                    .where(
                        session_items_table.c.session_id == str(session_id),
                        session_items_table.c.sequence > after_sequence,
                    )
                    .order_by(session_items_table.c.sequence)
                )
            ).mappings()
            return [_item_from_row(row) for row in rows]

    async def list_events(
        self,
        session_id: UUID,
        after_sequence: int = 0,
    ) -> list[RuntimeEvent]:
        """按稳定 sequence 返回可重放 RuntimeEvent。"""
        async with self._session_factory() as database_session:
            rows = (
                await database_session.execute(
                    select(runtime_events_table)
                    .where(
                        runtime_events_table.c.session_id == str(session_id),
                        runtime_events_table.c.sequence > after_sequence,
                    )
                    .order_by(runtime_events_table.c.sequence)
                )
            ).mappings()
            return [_event_from_row(row) for row in rows]

    async def get_token_usage(self, session_id: UUID) -> SessionTokenUsage:
        """只折叠模型步骤用量事件，避免扫描长会话中的文本增量。"""
        async with self._session_factory() as database_session:
            await _required_session_row(database_session, session_id)
            rows = (
                await database_session.execute(
                    select(
                        runtime_events_table.c.run_id,
                        runtime_events_table.c.sequence,
                        runtime_events_table.c.payload_json,
                    )
                    .where(
                        runtime_events_table.c.session_id == str(session_id),
                        runtime_events_table.c.type == "model_usage",
                    )
                    .order_by(runtime_events_table.c.sequence)
                )
            ).mappings()

        # 同一 Run/Step 的后写记录替换旧样本，恢复或重试不会造成重复计量。
        samples: dict[tuple[str, int], tuple[int, dict[str, object]]] = {}
        for row in rows:
            decoded: object = json.loads(row["payload_json"])
            if not isinstance(decoded, dict):
                continue
            payload = cast(dict[str, object], decoded)
            step = _non_negative_int(payload.get("step"))
            if step is None:
                continue
            samples[(str(row["run_id"]), step)] = (int(row["sequence"]), payload)

        input_tokens = 0
        output_tokens = 0
        measured_steps = 0
        unreported_steps = 0
        for _, payload in samples.values():
            step_input = _non_negative_int(payload.get("inputTokens"))
            step_output = _non_negative_int(payload.get("outputTokens"))
            input_tokens += step_input or 0
            output_tokens += step_output or 0
            if step_input is not None and step_output is not None:
                measured_steps += 1
            else:
                unreported_steps += 1

        ordered_samples = list(samples.values())
        latest_payload: dict[str, object] = (
            max(ordered_samples, key=lambda sample: sample[0])[1]
            if ordered_samples
            else {}
        )
        latest_input = _non_negative_int(latest_payload.get("inputTokens"))
        latest_output = _non_negative_int(latest_payload.get("outputTokens"))
        current_context_tokens = (
            latest_input + (latest_output or 0) if latest_input is not None else None
        )
        first_usage_sequence = (
            min(sample[0] for sample in ordered_samples) if ordered_samples else None
        )
        async with self._session_factory() as database_session:
            untracked_query = select(session_items_table.c.id).where(
                session_items_table.c.session_id == str(session_id),
                session_items_table.c.type.in_(
                    [SessionItemType.AGENT_MESSAGE.value, SessionItemType.ERROR.value]
                ),
            )
            if first_usage_sequence is not None:
                untracked_query = untracked_query.where(
                    session_items_table.c.sequence < first_usage_sequence
                )
            untracked_history = (
                await database_session.execute(untracked_query.limit(1))
            ).scalar_one_or_none() is not None
        return SessionTokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            # Provider 用量锚点加上本步输出，近似表示下一次请求前的当前上下文。
            current_context_tokens=current_context_tokens,
            context_window=_non_negative_int(latest_payload.get("contextWindow")),
            measured_steps=measured_steps,
            unreported_steps=unreported_steps,
            untracked_history=untracked_history,
        )

    async def _existing_execution(
        self,
        database_session: AsyncSession,
        turn_row: RowMapping,
        instruction: str,
    ) -> TurnExecution:
        """为幂等重放返回已有执行，调用者不会再次调度。"""
        user_item_row = (
            await database_session.execute(
                select(session_items_table.c.content_json).where(
                    session_items_table.c.turn_id == turn_row["id"],
                    session_items_table.c.type == SessionItemType.USER_MESSAGE.value,
                )
            )
        ).one()
        original_instruction = json.loads(user_item_row.content_json)["text"]
        if original_instruction != instruction:
            raise IdempotencyConflict("clientRequestId 已绑定另一段输入")
        run_row = (
            (
                await database_session.execute(
                    select(agent_runs_table).where(agent_runs_table.c.turn_id == turn_row["id"])
                )
            )
            .mappings()
            .one()
        )
        session_id = UUID(turn_row["session_id"])
        session_row = await _required_session_row(database_session, session_id)
        messages = await _model_messages(database_session, session_id)
        return TurnExecution(
            turn=_turn_from_row(turn_row),
            run=_run_from_row(run_row),
            instruction=instruction,
            messages=tuple(messages),
            newly_created=False,
            workspace_path=str(session_row["workspace_path"]),
            permission_profile=PermissionProfile(str(session_row["permission_profile"])),
            workspace_roots=await _session_workspace_roots(
                database_session,
                session_id,
                fallback=str(session_row["workspace_path"]),
            ),
        )

    async def _commit_terminal(
        self,
        execution: TurnExecution,
        *,
        run_status: AgentRunStatus,
        turn_status: TurnStatus,
        item_type: SessionItemType,
        item_status: SessionItemStatus,
        item_payload: dict[str, object],
    ) -> bool:
        """通过 terminal_event_id CAS 保证一个 Run 只能提交一次终态。"""
        async with self._session_factory.begin() as database_session:
            now = datetime.now(UTC)
            terminal_event_id = uuid4()
            claimed = await database_session.execute(
                update(agent_runs_table)
                .where(
                    agent_runs_table.c.id == str(execution.run.id.value),
                    agent_runs_table.c.terminal_event_id.is_(None),
                    agent_runs_table.c.status.in_(
                        [
                            AgentRunStatus.CREATED.value,
                            AgentRunStatus.RUNNING.value,
                            AgentRunStatus.WAITING_FOR_USER.value,
                        ]
                    ),
                )
                .values(
                    status=run_status.value,
                    finished_at=now,
                    terminal_event_id=str(terminal_event_id),
                )
            )
            if cast(Any, claimed).rowcount != 1:
                return False

            session_row = await _required_session_row(
                database_session,
                execution.run.session_id.value,
            )
            item_sequence = int(session_row["last_event_sequence"]) + 1
            terminal_sequence = item_sequence + 1
            await _append_event_and_item(
                database_session,
                event_id=uuid4(),
                item_id=uuid4(),
                session_id=execution.run.session_id.value,
                turn_id=execution.turn.id.value,
                run_id=execution.run.id.value,
                sequence=item_sequence,
                event_type=item_type.value,
                item_type=item_type,
                item_status=item_status,
                payload=item_payload,
                created_at=now,
            )
            await _append_event(
                database_session,
                event_id=terminal_event_id,
                session_id=execution.run.session_id.value,
                turn_id=execution.turn.id.value,
                run_id=execution.run.id.value,
                sequence=terminal_sequence,
                event_type=f"run_{run_status.value}",
                payload={"status": run_status.value},
                created_at=now,
            )
            finished_turn = await database_session.execute(
                update(turns_table)
                .where(
                    turns_table.c.id == str(execution.turn.id.value),
                    turns_table.c.status.in_(
                        [
                            TurnStatus.QUEUED.value,
                            TurnStatus.IN_PROGRESS.value,
                            TurnStatus.WAITING_FOR_USER.value,
                        ]
                    ),
                )
                .values(status=turn_status.value, finished_at=now)
            )
            if cast(Any, finished_turn).rowcount != 1:
                raise RuntimeError("AgentRun 与 Turn 状态不一致，终态提交已回滚")
            await database_session.execute(
                update(sessions_table)
                .where(sessions_table.c.id == str(execution.run.session_id.value))
                .values(
                    activity=SessionActivity.IDLE.value,
                    updated_at=now,
                    last_event_sequence=terminal_sequence,
                )
            )
        return True


async def _session_row(database_session: AsyncSession, session_id: UUID) -> RowMapping | None:
    """读取 Session 数据库行。"""
    return (
        (
            await database_session.execute(
                select(sessions_table).where(sessions_table.c.id == str(session_id))
            )
        )
        .mappings()
        .one_or_none()
    )


async def _required_session_row(database_session: AsyncSession, session_id: UUID) -> RowMapping:
    """读取必然存在的 Session 行。"""
    row = await _session_row(database_session, session_id)
    if row is None:
        raise SessionNotFound(f"Session 不存在：{session_id}")
    return row


async def _session_workspace_roots(
    database_session: AsyncSession,
    session_id: UUID,
    *,
    fallback: str,
) -> tuple[str, ...]:
    """读取 Session 的有序授权目录；兼容迁移过程中的单目录旧数据。"""
    rows = (
        await database_session.execute(
            select(session_workspace_roots_table.c.path)
            .where(session_workspace_roots_table.c.session_id == str(session_id))
            .order_by(session_workspace_roots_table.c.position)
        )
    ).all()
    return tuple(str(row.path) for row in rows) or (fallback,)


async def _model_messages(
    database_session: AsyncSession,
    session_id: UUID,
) -> list[ConversationMessage]:
    """从最终用户/助手 Item 重建当前模型可见历史。"""
    rows = (
        await database_session.execute(
            select(session_items_table)
            .where(
                session_items_table.c.session_id == str(session_id),
                session_items_table.c.type.in_(
                    [SessionItemType.USER_MESSAGE.value, SessionItemType.AGENT_MESSAGE.value]
                ),
                session_items_table.c.status == SessionItemStatus.COMPLETED.value,
            )
            .order_by(session_items_table.c.sequence)
        )
    ).mappings()
    messages: list[ConversationMessage] = []
    for row in rows:
        content = json.loads(row["content_json"])
        role = (
            MessageRole.USER
            if row["type"] == SessionItemType.USER_MESSAGE.value
            else MessageRole.ASSISTANT
        )
        messages.append(ConversationMessage(role=role, content=content["text"]))
    return messages


async def _append_event_and_item(
    database_session: AsyncSession,
    *,
    event_id: UUID,
    item_id: UUID,
    session_id: UUID,
    turn_id: UUID,
    run_id: UUID,
    sequence: int,
    event_type: str,
    item_type: SessionItemType,
    item_status: SessionItemStatus,
    payload: dict[str, object],
    created_at: datetime,
) -> None:
    """在当前事务追加事实及其用户侧投影。"""
    await _append_event(
        database_session,
        event_id=event_id,
        session_id=session_id,
        turn_id=turn_id,
        run_id=run_id,
        sequence=sequence,
        event_type=event_type,
        payload=payload,
        created_at=created_at,
    )
    await database_session.execute(
        insert(session_items_table).values(
            id=str(item_id),
            session_id=str(session_id),
            turn_id=str(turn_id),
            run_id=str(run_id),
            sequence=sequence,
            type=item_type.value,
            status=item_status.value,
            content_json=json.dumps(payload, ensure_ascii=False),
            created_at=created_at,
        )
    )


async def _append_event(
    database_session: AsyncSession,
    *,
    event_id: UUID,
    session_id: UUID,
    turn_id: UUID,
    run_id: UUID,
    sequence: int,
    event_type: str,
    payload: dict[str, object],
    created_at: datetime,
) -> None:
    """追加一条不可变 RuntimeEvent。"""
    await database_session.execute(
        insert(runtime_events_table).values(
            id=str(event_id),
            session_id=str(session_id),
            turn_id=str(turn_id),
            run_id=str(run_id),
            sequence=sequence,
            type=event_type,
            payload_json=json.dumps(payload, ensure_ascii=False),
            created_at=created_at,
        )
    )


def _turn_from_row(row: RowMapping) -> AgentTurn:
    """把 Turn 数据库行转换为领域对象。"""
    return AgentTurn(
        id=TurnId(UUID(row["id"])),
        session_id=SessionId(UUID(row["session_id"])),
        status=TurnStatus(row["status"]),
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


def _run_from_row(row: RowMapping) -> AgentRun:
    """把 AgentRun 数据库行转换为领域对象。"""
    return AgentRun(
        id=AgentRunId(UUID(row["id"])),
        session_id=SessionId(UUID(row["session_id"])),
        turn_id=TurnId(UUID(row["turn_id"])),
        attempt=row["attempt"],
        status=AgentRunStatus(row["status"]),
        model_ref=row["model_ref"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


def _item_from_row(row: RowMapping) -> SessionItem:
    """把 Item 数据库行转换为用户侧领域对象。"""
    run_id = UUID(row["run_id"]) if row["run_id"] is not None else None
    return SessionItem(
        id=SessionItemId(UUID(row["id"])),
        session_id=SessionId(UUID(row["session_id"])),
        turn_id=TurnId(UUID(row["turn_id"])),
        run_id=AgentRunId(run_id) if run_id is not None else None,
        sequence=row["sequence"],
        type=SessionItemType(row["type"]),
        status=SessionItemStatus(row["status"]),
        content=json.loads(row["content_json"]),
        created_at=row["created_at"],
    )


def _event_from_row(row: RowMapping) -> RuntimeEvent:
    """把事件数据库行转换为领域对象。"""
    run_id = UUID(row["run_id"]) if row["run_id"] is not None else None
    return RuntimeEvent(
        id=RuntimeEventId(UUID(row["id"])),
        session_id=SessionId(UUID(row["session_id"])),
        turn_id=TurnId(UUID(row["turn_id"])),
        run_id=AgentRunId(run_id) if run_id is not None else None,
        sequence=row["sequence"],
        type=row["type"],
        payload=json.loads(row["payload_json"]),
        created_at=row["created_at"],
    )


def _non_negative_int(value: object) -> int | None:
    """只接受 Runtime 自身写入的非负整数，损坏载荷不会污染统计。"""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _default_title(instruction: str) -> str:
    """从首轮输入生成短标题；后续可替换为异步模型命名。"""
    return " ".join(instruction.split())[:60]
