"""验证 Agent Runtime 在进程异常退出后的恢复语义。"""

import asyncio
from pathlib import Path

from aime.application.ports.conversation_store import TurnExecution
from aime.application.sessions.commands import CreateSessionCommand
from aime.application.sessions.exceptions import ActiveTurnConflict
from aime.application.sessions.services import CreateSession
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository


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
