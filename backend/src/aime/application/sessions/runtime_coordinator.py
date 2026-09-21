"""本地 Agent Runtime 的有界并发协调器。"""

import asyncio
import logging
from uuid import UUID

from aime.application.ports.agent_runtime import AgentRunRequest, AgentRuntime
from aime.application.ports.conversation_store import ConversationStore, TurnExecution
from aime.application.ports.tool_execution_store import ToolExecutionStore

logger = logging.getLogger(__name__)


class RuntimeCoordinator:
    """在应用进程内调度 AgentRun，并确保关闭时收敛活跃任务。"""

    def __init__(
        self,
        runtime: AgentRuntime,
        store: ConversationStore,
        *,
        max_concurrent_sessions: int = 2,
        tool_store: ToolExecutionStore | None = None,
    ) -> None:
        self._runtime = runtime
        self._store = store
        self._capacity = asyncio.Semaphore(max_concurrent_sessions)
        self._tool_store = tool_store
        self._tasks: set[asyncio.Task[None]] = set()
        self._active_turns: dict[str, tuple[asyncio.Task[None], TurnExecution]] = {}
        self._waiting_turns: set[str] = set()

    def submit(self, execution: TurnExecution) -> None:
        """提交一次已持久化执行；重复请求不会产生第二个后台任务。"""
        if not execution.newly_created:
            return
        self._schedule(execution, claim_start=True)

    def resume(self, execution: TurnExecution) -> None:
        """恢复数据库中等待审批的既有 Run。"""
        self._schedule(execution, claim_start=False)

    def _schedule(self, execution: TurnExecution, *, claim_start: bool) -> None:
        """确保同一 Turn 在当前进程只对应一个后台任务。"""
        turn_id = str(execution.turn.id.value)
        if turn_id in self._active_turns:
            return
        task = asyncio.create_task(self._execute(execution, claim_start=claim_start))
        self._tasks.add(task)
        self._active_turns[turn_id] = (task, execution)
        task.add_done_callback(lambda completed: self._forget(turn_id, completed))

    async def interrupt(self, session_id: UUID, turn_id: UUID) -> bool:
        """取消属于指定 Session 的活跃 Turn，并持久化中断终态。"""
        active = self._active_turns.get(str(turn_id))
        if active is None:
            return False
        task, execution = active
        if execution.turn.session_id.value != session_id:
            return False
        cancellation_requested = task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if not cancellation_requested:
            return False
        interrupted = await self._store.interrupt_run(execution)
        if interrupted and self._tool_store is not None:
            await self._tool_store.cancel_run_approvals(
                execution.run.id.value,
                "执行已被用户中断",
            )
        return interrupted

    async def close(self) -> None:
        """等待短任务结束；超时后取消并让取消路径写入终态。"""
        if not self._tasks:
            return
        waiting_tasks = {
            task
            for turn_id, (task, _) in self._active_turns.items()
            if turn_id in self._waiting_turns
        }
        # 等待审批的 Run 已经完整持久化，关闭时直接挂起，下一进程会从账本恢复。
        for task in waiting_tasks:
            task.cancel()
        if waiting_tasks:
            await asyncio.gather(*waiting_tasks, return_exceptions=True)
        running_tasks = set(self._tasks) - waiting_tasks
        if not running_tasks:
            return
        done, pending = await asyncio.wait(running_tasks, timeout=10)
        interrupted = [
            execution
            for task, execution in self._active_turns.values()
            if task in pending and str(execution.turn.id.value) not in self._waiting_turns
        ]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            for execution in interrupted:
                await self._store.interrupt_run(execution)
        for task in done:
            if not task.cancelled():
                task.exception()

    async def _execute(self, execution: TurnExecution, *, claim_start: bool) -> None:
        """消费 Runtime 事件，并把本轮最终结果提交给持久化端口。"""
        capacity_held = False
        turn_id = str(execution.turn.id.value)
        try:
            await self._capacity.acquire()
            capacity_held = True
            if claim_start and not await self._store.mark_run_started(execution):
                return
            response_parts: list[str] = []
            request = AgentRunRequest(
                instruction=execution.instruction,
                session_id=str(execution.run.session_id.value),
                turn_id=turn_id,
                run_id=str(execution.run.id.value),
                model_ref=execution.run.model_ref,
                messages=execution.messages,
                workspace_path=execution.workspace_path,
                permission_profile=execution.permission_profile,
                workspace_roots=execution.workspace_roots,
            )
            async for event in self._runtime.run(request):
                if event.type == "text_delta":
                    await self._store.append_run_event(
                        execution,
                        event.type,
                        {"text": event.content},
                    )
                    response_parts.append(event.content)
                elif event.type == "response_restored":
                    response_parts = [event.content]
                    await self._store.append_run_event(
                        execution,
                        event.type,
                        {"text": event.content},
                    )
                elif event.type == "model_attempt_discarded":
                    # 已发布增量保留在事件日志中，最终回答移除失败尝试的尾部。
                    value = (event.payload or {}).get("discardedChars", 0)
                    discarded = value if isinstance(value, int) and value > 0 else 0
                    joined = "".join(response_parts)
                    response_parts = [joined[:-discarded]] if discarded else response_parts
                    await self._store.append_run_event(execution, event.type, event.payload or {})
                elif event.type == "failed":
                    await self._store.fail_run(execution, event.content)
                    return
                elif event.type == "approval_required":
                    await self._store.append_run_event(
                        execution,
                        event.type,
                        event.payload or {},
                    )
                    if not await self._store.mark_run_waiting(execution):
                        raise RuntimeError("AgentRun 无法进入 waiting_for_user")
                    self._waiting_turns.add(turn_id)
                    self._capacity.release()
                    capacity_held = False
                elif event.type == "approval_resolved":
                    await self._capacity.acquire()
                    capacity_held = True
                    if not await self._store.mark_run_resumed(execution):
                        raise RuntimeError("AgentRun 无法从 waiting_for_user 恢复")
                    self._waiting_turns.discard(turn_id)
                    await self._store.append_run_event(
                        execution,
                        event.type,
                        event.payload or {},
                    )
                elif event.type == "runtime_resumed":
                    if not await self._store.mark_run_resumed(execution):
                        raise RuntimeError("恢复的 AgentRun 无法重新进入 running")
                    await self._store.append_run_event(
                        execution,
                        event.type,
                        event.payload or {},
                    )
                else:
                    await self._store.append_run_event(
                        execution,
                        event.type,
                        event.payload or ({"content": event.content} if event.content else {}),
                    )
            response_text = "".join(response_parts)
            if not response_text.strip():
                await self._store.fail_run(execution, "模型未返回可显示内容")
                return
            await self._store.complete_run(execution, response_text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 后台边界必须把未知错误收敛为 Run 终态
            await self._store.fail_run(execution, str(exc))
        finally:
            if capacity_held:
                self._capacity.release()
            self._waiting_turns.discard(turn_id)

    def _forget(self, turn_id: str, task: asyncio.Task[None]) -> None:
        """移除调度记录，并消费未能持久化的后台异常。"""
        self._tasks.discard(task)
        active = self._active_turns.get(turn_id)
        if active is not None and active[0] is task:
            self._active_turns.pop(turn_id, None)
        if task.cancelled():
            return
        exception = task.exception()
        if exception is not None:
            execution = active[1] if active is not None else None
            logger.critical(
                "Agent Runtime 后台任务异常且未能收敛：session_id=%s turn_id=%s run_id=%s",
                execution.run.session_id.value if execution is not None else "unknown",
                turn_id,
                execution.run.id.value if execution is not None else "unknown",
                exc_info=(type(exception), exception, exception.__traceback__),
            )
