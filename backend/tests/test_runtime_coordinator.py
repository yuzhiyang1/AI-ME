"""验证本地 Runtime 调度边界。"""

import asyncio
import logging
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from aime.application.ports.agent_runtime import AgentEvent, AgentRunRequest
from aime.application.ports.conversation_store import TurnExecution
from aime.application.ports.model_gateway import ConversationMessage, MessageRole
from aime.application.sessions.runtime_coordinator import RuntimeCoordinator
from aime.domain.sessions.entities import AgentRun, AgentTurn
from aime.domain.sessions.value_objects import (
    AgentRunId,
    AgentRunStatus,
    SessionId,
    TurnId,
    TurnStatus,
)


class _GateRuntime:
    """由测试控制结束时机的 Runtime。"""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.started = 0
        self.active = 0
        self.maximum_active = 0

    async def run(self, request: AgentRunRequest):  # type: ignore[no-untyped-def]
        self.started += 1
        self.active += 1
        self.maximum_active = max(self.maximum_active, self.active)
        try:
            await self.release.wait()
            yield AgentEvent(type="text_delta", content="完成")
        finally:
            self.active -= 1


class _RecordingStore:
    """只记录协调器结果的测试存储端口。"""

    def __init__(self) -> None:
        self.started: list[str] = []
        self.completed: list[str] = []

    async def mark_run_started(self, execution: TurnExecution) -> bool:
        self.started.append(str(execution.run.id.value))
        return True

    async def append_run_event(self, *args: object, **kwargs: object) -> None:
        return None

    async def complete_run(self, execution: TurnExecution, response_text: str) -> bool:
        self.completed.append(response_text)
        return True

    async def fail_run(self, execution: TurnExecution, message: str) -> bool:
        raise AssertionError(message)

    async def interrupt_run(self, execution: TurnExecution) -> bool:
        raise AssertionError("测试不应中断")


class _ExplodingRuntime:
    """模拟 Runtime 与错误持久化连续失败的极端边界。"""

    async def run(self, request: AgentRunRequest):  # type: ignore[no-untyped-def]
        if False:
            yield AgentEvent(type="text_delta", content="不会执行")
        raise RuntimeError("runtime-down")


class _FailingTerminalStore(_RecordingStore):
    """模拟终态数据库也不可写，用于验证异常仍会被消费并记录。"""

    async def fail_run(self, execution: TurnExecution, message: str) -> bool:
        raise RuntimeError("state-store-down")


async def test_discarded_model_attempt_is_not_in_final_answer() -> None:
    """溢出失败的已展示草稿只留在事件日志，不能混入成功回答。"""
    class RecoveringRuntime:
        async def run(self, request):
            yield AgentEvent(type="response_restored", content="已完成部分。")
            yield AgentEvent(type="text_delta", content="失败😀草稿")
            yield AgentEvent(type="model_attempt_discarded", payload={"discardedChars": 5})
            yield AgentEvent(type="text_delta", content="恢复后的回答")

    store = _RecordingStore()
    coordinator = RuntimeCoordinator(RecoveringRuntime(), store)  # type: ignore[arg-type]
    coordinator.submit(_execution())
    await coordinator.close()
    assert store.completed == ["已完成部分。恢复后的回答"]


async def test_runtime_runs_at_most_two_sessions_concurrently() -> None:
    """本地第一期最多同时运行两个 Session，第三个必须排队。"""
    runtime = _GateRuntime()
    store = _RecordingStore()
    coordinator = RuntimeCoordinator(runtime, store, max_concurrent_sessions=2)  # type: ignore[arg-type]
    for _ in range(3):
        coordinator.submit(_execution())

    for _ in range(100):
        if runtime.started == 2:
            break
        await asyncio.sleep(0)

    assert runtime.started == 2
    assert runtime.maximum_active == 2
    assert len(store.started) == 2

    runtime.release.set()
    await coordinator.close()

    assert runtime.started == 3
    assert len(store.started) == 3
    assert store.completed == ["完成", "完成", "完成"]


async def test_unpersisted_background_failure_is_consumed_and_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """终态存储也失败时，后台 Task 异常不能变成无人消费的警告。"""
    coordinator = RuntimeCoordinator(  # type: ignore[arg-type]
        _ExplodingRuntime(),
        _FailingTerminalStore(),
    )
    with caplog.at_level(logging.CRITICAL):
        coordinator.submit(_execution())
        for _ in range(100):
            if "未能收敛" in caplog.text:
                break
            await asyncio.sleep(0)

    assert "Agent Runtime 后台任务异常且未能收敛" in caplog.text
    assert "state-store-down" in caplog.text


def _execution() -> TurnExecution:
    """构造一条独立 Session 的已持久化执行。"""
    now = datetime.now(UTC)
    session_id = SessionId(uuid4())
    turn_id = TurnId(uuid4())
    return TurnExecution(
        turn=AgentTurn(
            id=turn_id,
            session_id=session_id,
            status=TurnStatus.QUEUED,
            created_at=now,
            started_at=None,
            finished_at=None,
        ),
        run=AgentRun(
            id=AgentRunId(uuid4()),
            session_id=session_id,
            turn_id=turn_id,
            attempt=1,
            status=AgentRunStatus.CREATED,
            model_ref="fake/model",
            started_at=now,
            finished_at=None,
        ),
        instruction="测试",
        messages=(ConversationMessage(role=MessageRole.USER, content="测试"),),
        newly_created=True,
    )
