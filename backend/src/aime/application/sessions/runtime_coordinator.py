"""本地 Agent Runtime 的有界并发协调器。"""

import asyncio
import logging
from uuid import UUID

from aime.application.ports.agent_runtime import AgentRunRequest, AgentRuntime
from aime.application.ports.conversation_store import ConversationStore, TurnExecution

logger = logging.getLogger(__name__)


class RuntimeCoordinator:
    """在应用进程内调度 AgentRun，并确保关闭时收敛活跃任务。"""

    def __init__(
        self,
        runtime: AgentRuntime,
        store: ConversationStore,
        *,
        max_concurrent_sessions: int = 2,
    ) -> None:
        self._runtime = runtime
        self._store = store
        self._capacity = asyncio.Semaphore(max_concurrent_sessions)
        self._tasks: set[asyncio.Task[None]] = set()
        self._active_turns: dict[str, tuple[asyncio.Task[None], TurnExecution]] = {}

    def submit(self, execution: TurnExecution) -> None:
        """提交一次已持久化执行；重复请求不会产生第二个后台任务。"""
        if not execution.newly_created:
            return
        task = asyncio.create_task(self._execute(execution))
        self._tasks.add(task)
        turn_id = str(execution.turn.id.value)
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
        return await self._store.interrupt_run(execution)

    async def close(self) -> None:
        """等待短任务结束；超时后取消并让取消路径写入终态。"""
        if not self._tasks:
            return
        done, pending = await asyncio.wait(self._tasks, timeout=10)
        interrupted = [
            execution
            for task, execution in self._active_turns.values()
            if task in pending
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

    async def _execute(self, execution: TurnExecution) -> None:
        """消费 Runtime 事件，并把本轮最终结果提交给持久化端口。"""
        try:
            async with self._capacity:
                if not await self._store.mark_run_started(execution):
                    return
                response_parts: list[str] = []
                request = AgentRunRequest(
                    instruction=execution.instruction,
                    session_id=str(execution.run.session_id.value),
                    turn_id=str(execution.turn.id.value),
                    run_id=str(execution.run.id.value),
                    model_ref=execution.run.model_ref,
                    messages=execution.messages,
                )
                async for event in self._runtime.run(request):
                    if event.type == "text_delta":
                        await self._store.append_run_event(
                            execution,
                            event.type,
                            {"text": event.content},
                        )
                        response_parts.append(event.content)
                    elif event.type == "failed":
                        await self._store.fail_run(execution, event.content)
                        return
                response_text = "".join(response_parts)
                if not response_text.strip():
                    await self._store.fail_run(execution, "模型未返回可显示内容")
                    return
                await self._store.complete_run(execution, response_text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 后台边界必须把未知错误收敛为 Run 终态
            await self._store.fail_run(execution, str(exc))

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
