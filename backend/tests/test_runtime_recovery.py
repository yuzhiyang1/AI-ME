"""验证 Agent Runtime 在进程异常退出后的恢复语义。"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from aime.application.ports.conversation_store import TurnExecution
from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmTextDelta,
    LlmToolCall,
    LlmToolResultMessage,
    ModelDescriptor,
)
from aime.application.ports.tool_execution import ToolExecutionContext, ToolExecutionResult
from aime.application.sessions.commands import CreateSessionCommand
from aime.application.sessions.exceptions import ActiveTurnConflict
from aime.application.sessions.services import CreateSession
from aime.composition import build_container
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository
from aime.infrastructure.persistence.sqlite_tool_execution_store import SqliteToolExecutionStore
from aime.infrastructure.tools.builtin import BuiltInToolRegistry
from aime.main import create_app


class _RecoveredToolGateway:
    """接收恢复调用的结果，不应被要求重新生成原工具调用。"""

    def __init__(self) -> None:
        self.call_count = 0

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        result = request.messages[-1]
        assert isinstance(result, LlmToolResultMessage)
        assert json.loads(result.content)["error"]["code"] == "approval_rejected"
        yield LlmTextDelta("已保留现场，没有重放结果不确定的命令")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _RecoveredCompletedToolGateway:
    """确认 T2 结果被复用后直接完成，不生成新的工具调用。"""

    def __init__(self) -> None:
        self.call_count = 0

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        result = request.messages[-1]
        assert isinstance(result, LlmToolResultMessage)
        assert json.loads(result.content)["exit_code"] == 0
        yield LlmTextDelta("复用了崩溃前已经保存的工具结果")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


async def test_incomplete_run_is_marked_interrupted_after_restart(tmp_path: Path) -> None:
    """没有 terminal fact 的 Run 必须在下一次启动时收敛为 interrupted。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_dir = tmp_path / "state"
    database = SqliteDatabase(state_dir)
    await database.initialize()
    repository = SqliteSessionRepository(database.session_factory)
    session = await CreateSession(repository).execute(
        CreateSessionCommand(
            workspace_path=str(workspace),
            default_model="openai/gpt-5",
            permission_profile=PermissionProfile.WORKSPACE_WRITE,
        )
    )
    store = SqliteConversationStore(database.session_factory)
    await store.start_turn(
        session_id=session.id.value,
        instruction="处理一个长任务",
        client_request_id="crashed-request",
    )
    await database.close()

    reopened_database = SqliteDatabase(state_dir)
    await reopened_database.initialize()
    reopened_store = SqliteConversationStore(reopened_database.session_factory)
    recovered_count = await reopened_store.recover_incomplete_runs()
    items = await reopened_store.list_items(session.id.value)
    events = await reopened_store.list_events(session.id.value)
    recovered_session = await SqliteSessionRepository(reopened_database.session_factory).get(
        session.id
    )
    await reopened_database.close()

    assert recovered_count == 1
    assert recovered_session is not None
    assert recovered_session.activity.value == "idle"
    assert [item.type.value for item in items] == ["user_message", "error"]
    assert items[-1].content == {"message": "上次运行因应用异常退出而中断"}
    assert events[-1].type == "run_interrupted"


async def test_database_allows_only_one_concurrent_turn_per_session(tmp_path: Path) -> None:
    """并发请求即使同时到达，也只能有一个 Turn 成功创建。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    database = SqliteDatabase(tmp_path / "state")
    await database.initialize()
    repository = SqliteSessionRepository(database.session_factory)
    session = await CreateSession(repository).execute(
        CreateSessionCommand(
            workspace_path=str(workspace),
            default_model="openai/gpt-5",
            permission_profile=PermissionProfile.WORKSPACE_WRITE,
        )
    )
    store = SqliteConversationStore(database.session_factory)

    results = await asyncio.gather(
        store.start_turn(
            session_id=session.id.value,
            instruction="任务一",
            client_request_id="concurrent-one",
        ),
        store.start_turn(
            session_id=session.id.value,
            instruction="任务二",
            client_request_id="concurrent-two",
        ),
        return_exceptions=True,
    )
    await database.close()

    assert sum(isinstance(result, TurnExecution) for result in results) == 1
    assert sum(isinstance(result, ActiveTurnConflict) for result in results) == 1


async def test_run_terminal_fact_is_committed_only_once_under_race(tmp_path: Path) -> None:
    """完成与中断同时发生时，只允许一个终态和一个终态 Item 获胜。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    database = SqliteDatabase(tmp_path / "state")
    await database.initialize()
    repository = SqliteSessionRepository(database.session_factory)
    session = await CreateSession(repository).execute(
        CreateSessionCommand(
            workspace_path=str(workspace),
            default_model="openai/gpt-5",
            permission_profile=PermissionProfile.WORKSPACE_WRITE,
        )
    )
    store = SqliteConversationStore(database.session_factory)
    execution = await store.start_turn(
        session_id=session.id.value,
        instruction="并发终态测试",
        client_request_id="terminal-race",
    )
    assert await store.mark_run_started(execution) is True

    committed = await asyncio.gather(
        store.complete_run(execution, "任务完成"),
        store.interrupt_run(execution),
    )
    items = await store.list_items(session.id.value)
    events = await store.list_events(session.id.value)
    await database.close()

    assert sum(committed) == 1
    assert len(items) == 2
    assert sum(event.type.startswith("run_") for event in events) == 1
    assert items[-1].type.value in {"agent_message", "error"}


async def test_repeated_interrupt_is_idempotent(tmp_path: Path) -> None:
    """重复中断同一个 Run 时，第二次不得追加重复错误事实。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    database = SqliteDatabase(tmp_path / "state")
    await database.initialize()
    repository = SqliteSessionRepository(database.session_factory)
    session = await CreateSession(repository).execute(
        CreateSessionCommand(
            workspace_path=str(workspace),
            default_model="openai/gpt-5",
            permission_profile=PermissionProfile.WORKSPACE_WRITE,
        )
    )
    store = SqliteConversationStore(database.session_factory)
    execution = await store.start_turn(
        session_id=session.id.value,
        instruction="重复中断测试",
        client_request_id="double-interrupt",
    )

    assert await store.interrupt_run(execution) is True
    assert await store.interrupt_run(execution) is False
    items = await store.list_items(session.id.value)
    events = await store.list_events(session.id.value)
    await database.close()

    assert [item.type.value for item in items] == ["user_message", "error"]
    assert [event.type for event in events].count("run_interrupted") == 1


def test_started_tool_without_t2_becomes_uncertain_approval_after_restart(
    tmp_path: Path,
) -> None:
    """缺少 T2 的副作用不能自动重放，必须把不确定事实交给用户处理。"""

    async def arrange_crashed_state() -> tuple[str, Path]:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        database = SqliteDatabase(tmp_path / "state")
        await database.initialize()
        repository = SqliteSessionRepository(database.session_factory)
        session = await CreateSession(repository).execute(
            CreateSessionCommand(
                workspace_path=str(workspace),
                default_model="qa/tool-model",
                permission_profile=PermissionProfile.WORKSPACE_WRITE,
            )
        )
        conversation_store = SqliteConversationStore(database.session_factory)
        execution = await conversation_store.start_turn(
            session_id=session.id.value,
            instruction="执行可能已经发生的命令",
            client_request_id="uncertain-tool",
        )
        assert await conversation_store.mark_run_started(execution)
        descriptor = next(
            descriptor
            for descriptor in BuiltInToolRegistry().descriptors(PermissionProfile.WORKSPACE_WRITE)
            if descriptor.definition.name == "run_powershell"
        )
        invocation_store = SqliteToolExecutionStore(database.session_factory)
        invocation = await invocation_store.prepare_invocation(
            ToolExecutionContext(
                session_id=str(session.id.value),
                turn_id=str(execution.turn.id.value),
                run_id=str(execution.run.id.value),
                workspace_path=str(workspace),
                permission_profile=PermissionProfile.WORKSPACE_WRITE,
            ),
            LlmToolCall(
                "uncertain-shell",
                "run_powershell",
                '{"command":"Set-Content marker.txt maybe"}',
            ),
            descriptor,
            {"command": "Set-Content marker.txt maybe"},
            step_index=1,
            call_index=0,
            assistant_text="",
        )
        await invocation_store.mark_running(invocation.id)
        marker = workspace / "marker.txt"
        marker.write_text("maybe", encoding="utf-8")
        await database.close()
        return str(session.id.value), marker

    session_id, marker = asyncio.run(arrange_crashed_state())
    gateway = _RecoveredToolGateway()
    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        approvals = client.get(f"/api/sessions/{session_id}/approvals").json()
        assert len(approvals) == 1
        assert "无法确认副作用是否发生" in approvals[0]["reason"]
        assert gateway.call_count == 0

        client.post(
            f"/api/sessions/{session_id}/approvals/{approvals[0]['id']}/decision",
            json={"decision": "reject"},
        )
        for _ in range(300):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)

    assert marker.read_text(encoding="utf-8") == "maybe"
    assert gateway.call_count == 1
    assert items[-1]["content"] == {"text": "已保留现场，没有重放结果不确定的命令"}


def test_completed_tool_with_t2_is_reused_after_restart_without_replay(tmp_path: Path) -> None:
    """已经提交 T2 的副作用只回填模型，恢复时不得再次执行。"""

    async def arrange_completed_tool() -> tuple[str, Path]:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        database = SqliteDatabase(tmp_path / "state")
        await database.initialize()
        session = await CreateSession(SqliteSessionRepository(database.session_factory)).execute(
            CreateSessionCommand(
                workspace_path=str(workspace),
                default_model="qa/tool-model",
                permission_profile=PermissionProfile.WORKSPACE_WRITE,
            )
        )
        conversation_store = SqliteConversationStore(database.session_factory)
        execution = await conversation_store.start_turn(
            session_id=session.id.value,
            instruction="执行一次追加命令",
            client_request_id="completed-tool-recovery",
        )
        assert await conversation_store.mark_run_started(execution)
        descriptor = next(
            item
            for item in BuiltInToolRegistry().descriptors(PermissionProfile.WORKSPACE_WRITE)
            if item.definition.name == "run_powershell"
        )
        store = SqliteToolExecutionStore(database.session_factory)
        invocation = await store.prepare_invocation(
            ToolExecutionContext(
                session_id=str(session.id.value),
                turn_id=str(execution.turn.id.value),
                run_id=str(execution.run.id.value),
                workspace_path=str(workspace),
                permission_profile=PermissionProfile.WORKSPACE_WRITE,
            ),
            LlmToolCall(
                "completed-shell",
                "run_powershell",
                '{"command":"Add-Content marker.txt x"}',
            ),
            descriptor,
            {"command": "Add-Content marker.txt x"},
            step_index=1,
            call_index=0,
            assistant_text="",
        )
        await store.mark_running(invocation.id)
        marker = workspace / "marker.txt"
        marker.write_text("x", encoding="utf-8")
        await store.finish_invocation(
            invocation.id,
            ToolExecutionResult({"exit_code": 0, "stdout": "", "stderr": "", "truncated": False}),
        )
        await database.close()
        return str(session.id.value), marker

    session_id, marker = asyncio.run(arrange_completed_tool())
    gateway = _RecoveredCompletedToolGateway()
    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        assert client.get(f"/api/sessions/{session_id}/approvals").json() == []
        for _ in range(300):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)

    assert marker.read_text(encoding="utf-8") == "x"
    assert gateway.call_count == 1
    assert items[-1]["content"] == {"text": "复用了崩溃前已经保存的工具结果"}
