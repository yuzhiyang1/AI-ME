"""窗口、预算与产物的行为测试，使用真实 SQLite 和可控模型。"""

import json
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text

from aime.application.context.service import RunContext
from aime.application.ports.agent_runtime import AgentRunRequest
from aime.application.ports.context_store import PendingContextStep
from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmAssistantToolCallMessage,
    LlmCompletionRequest,
    LlmError,
    LlmErrorCategory,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamFailed,
    LlmTextDelta,
    LlmToolCall,
    LlmToolCallDelta,
    LlmToolResultMessage,
    MessageRole,
    ModelDescriptor,
)
from aime.application.ports.tool_execution import ToolExecutionContext, ToolExecutionResult
from aime.application.sessions.commands import CreateSessionCommand
from aime.application.sessions.services import CreateSession
from aime.domain.context.budget import ContextBudget, ContextError
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.llm.errors import classify_provider_error
from aime.infrastructure.llm.token_counter import ConservativeTokenCounter
from aime.infrastructure.persistence.local_artifact_store import LocalArtifactStore
from aime.infrastructure.persistence.sqlite_context_store import SqliteContextStore
from aime.infrastructure.persistence.sqlite_conversation_store import SqliteConversationStore
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_session_repository import SqliteSessionRepository
from aime.infrastructure.persistence.sqlite_tool_execution_store import SqliteToolExecutionStore
from aime.infrastructure.runtime.approval_broker import InMemoryApprovalBroker
from aime.infrastructure.runtime.model_agent_runtime import ModelAgentRuntime
from aime.infrastructure.tools.builtin import BuiltInToolRegistry
from aime.infrastructure.tools.context_tools import ContextToolRegistry


@pytest.fixture
async def context_env(tmp_path: Path):
    database = SqliteDatabase(tmp_path / "state")
    await database.initialize()
    session = await CreateSession(SqliteSessionRepository(database.session_factory)).execute(
        CreateSessionCommand(
            workspace_path=str(tmp_path),
            default_model="qa/context",
            permission_profile=PermissionProfile.WORKSPACE_WRITE,
        )
    )
    conversation = SqliteConversationStore(database.session_factory)
    execution = await conversation.start_turn(
        session_id=session.id.value,
        instruction="完成任务；保留中文约束，不要删除文件",
        client_request_id="context-test",
    )
    await conversation.mark_run_started(execution)
    request = AgentRunRequest(
        execution.instruction,
        str(session.id.value),
        str(execution.turn.id.value),
        str(execution.run.id.value),
        "qa/context",
        execution.messages,
        str(tmp_path),
        PermissionProfile.WORKSPACE_WRITE,
    )
    store = SqliteContextStore(database.session_factory)
    await store.initialize(
        request.session_id,
        request.turn_id,
        request.run_id,
        request.messages,
        request.instruction,
    )
    artifacts = LocalArtifactStore(tmp_path / "artifacts")
    yield database, store, artifacts, request
    await database.close()


def checkpoint_body() -> dict[str, object]:
    return {
        "goal": "完成任务",
        "progress": "已读取",
        "constraints": "不要删除文件",
        "decisions": "保持中文",
        "failed_attempts": "",
        "next_steps": "验证",
        "references": [],
    }


async def test_checkpoint_versions_references_and_idempotency(context_env) -> None:
    _, store, _, request = context_env
    sid = request.session_id
    seq = await store.latest_sequence(sid)
    body = checkpoint_body()
    saved = await store.write_checkpoint(sid, request.run_id, "one", 0, seq, body)
    assert saved.version == 1
    assert await store.write_checkpoint(sid, request.run_id, "one", 0, seq, body) == saved
    with pytest.raises(ContextError, match="checkpoint_conflict"):
        await store.write_checkpoint(sid, request.run_id, "two", 0, seq, body)
    with pytest.raises(ContextError, match="reference_invalid"):
        await store.write_checkpoint(
            sid, request.run_id, "three", 1, seq, {**body, "references": [seq + 999]}
        )
    with pytest.raises(ContextError, match="too_large"):
        await store.write_checkpoint(
            sid, request.run_id, "four", 1, seq, {**body, "goal": "大" * 5000}
        )


async def test_rollover_is_atomic_idempotent_and_restorable(context_env) -> None:
    database, store, _, request = context_env
    sid = request.session_id
    before = await store.window(sid)
    seq = await store.latest_sequence(sid)
    baseline = [ConversationMessage(MessageRole.USER, request.instruction)]
    next_window = await store.rollover(
        sid,
        request.run_id,
        "roll-1",
        before.id,
        seq,
        baseline,
        "test",
    )
    assert next_window.number == 2
    assert (
        await store.rollover(
            sid,
            request.run_id,
            "roll-1",
            before.id,
            seq,
            baseline,
            "test",
        )
        == next_window
    )
    restored = SqliteContextStore(database.session_factory)
    assert await restored.window(sid) == next_window
    assert await restored.messages(sid) == baseline
    with pytest.raises(ContextError, match="context_conflict"):
        await store.rollover(sid, request.run_id, "roll-2", before.id, seq, baseline, "test")
    async with database.session_factory() as db:
        assert (
            await db.execute(text("SELECT count(*) FROM context_windows WHERE active=1"))
        ).scalar_one() == 1
        assert (
            await db.execute(
                text("SELECT count(*) FROM runtime_events WHERE type='context_window_started'")
            )
        ).scalar_one() == 1


async def test_request_counter_and_explicit_limit_survive_new_store(context_env) -> None:
    database, store, _, request = context_env
    assert await store.begin_request(request.run_id, 2) == 1
    assert await store.claim_overflow(request.run_id, 1)
    window = await store.window(request.session_id)
    assert await store.claim_maintenance(request.run_id, window.id)
    restored = SqliteContextStore(database.session_factory)
    assert not await restored.claim_overflow(request.run_id, 1)
    assert not await restored.claim_maintenance(request.run_id, window.id)
    assert await restored.begin_request(request.run_id, 2) == 2
    with pytest.raises(ContextError, match="run_budget_exhausted"):
        await restored.begin_request(request.run_id, 2)


async def test_request_counter_has_no_default_limit(context_env) -> None:
    database, store, _, request = context_env

    for expected in range(1, 41):
        assert await store.begin_request(request.run_id) == expected

    restored = SqliteContextStore(database.session_factory)
    assert (await restored.progress(request.run_id)).request_count == 40


async def test_history_is_scoped_searchable_and_bounded(context_env) -> None:
    _, store, _, request = context_env
    await store.record_step(
        request.session_id,
        request.run_id,
        1,
        [
            ConversationMessage(MessageRole.ASSISTANT, "needle" + "长内容" * 9000),
        ],
        None,
        0,
    )
    found = await store.history(request.session_id, query="needle")
    item = found["items"][0]
    assert len(item["preview"]) <= 300
    page = await store.read_history(request.session_id, item["id"], limit=999999)
    assert len(page["content"]) == 4000
    assert page["next_offset"] == 4000
    assert (await store.history(str(uuid4()), query="needle"))["items"] == []
    with pytest.raises(ContextError, match="history_not_found"):
        await store.read_history(str(uuid4()), item["id"])


async def test_artifact_keeps_full_result_and_bounds_reads(tmp_path: Path) -> None:
    artifacts = LocalArtifactStore(tmp_path)
    sid = str(uuid4())
    content = "header\n" + "x" * 100_000 + "\ntarget at tail"
    saved = await artifacts.save(sid, content)
    assert saved["capture_complete"] is True
    assert saved["total_bytes"] == len(content)
    assert len(saved["preview"]) < 4200
    first = await artifacts.read(sid, saved["artifact_id"], limit=999999)
    assert len(first["content"]) == 4000
    page = await artifacts.search(sid, saved["artifact_id"], "target")
    assert not page["matches"]
    second = await artifacts.search(sid, saved["artifact_id"], "target", page["next_offset"])
    assert second["matches"][0]["offset_bytes"] == content.index("target")
    with pytest.raises(ContextError, match="artifact_not_found"):
        await artifacts.read(str(uuid4()), saved["artifact_id"])
    with pytest.raises(ValueError):
        await artifacts.read(sid, "../escape")


async def test_capture_limit_is_explicit_and_drains_source(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "aime.infrastructure.persistence.local_artifact_store.MAX_ARTIFACT_BYTES", 100
    )
    count = 0

    async def source() -> AsyncIterator[bytes]:
        nonlocal count
        for _ in range(10):
            count += 1
            yield b"x" * 30

    result = await LocalArtifactStore(tmp_path).capture(str(uuid4()), source())
    assert count == 10
    assert result["capture_complete"] is False
    assert result["saved_bytes"] == 100
    assert result["total_bytes"] == 300


class ScriptGateway:
    def __init__(self, actions, capacity: int = 32_000) -> None:
        self.actions = actions
        self.requests: list[LlmCompletionRequest] = []
        self.capacity = capacity

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "context", "Context", self.capacity)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        index = len(self.requests)
        self.requests.append(request)
        action = self.actions[index]
        if callable(action):
            action = action(request)
        for event in action:
            yield event


def call(name: str, arguments: dict[str, object], call_id: str):
    return [
        LlmToolCallDelta(0, call_id, name, json.dumps(arguments, ensure_ascii=False)),
        LlmStreamCompleted(LlmFinishReason.TOOL_CALLS),
    ]


def runtime_for(context_env, gateway, *, max_steps: int | None = None) -> ModelAgentRuntime:
    database, store, artifacts, _ = context_env
    return ModelAgentRuntime(
        gateway,
        SqliteToolExecutionStore(database.session_factory),
        InMemoryApprovalBroker(),
        BuiltInToolRegistry(artifacts),
        context_store=store,
        artifact_store=artifacts,
        token_counter=ConservativeTokenCounter(),
        max_steps=max_steps,
    )


async def test_runtime_can_continue_beyond_legacy_32_request_limit(context_env) -> None:
    _, store, _, request = context_env
    gateway = ScriptGateway(
        [call("get_context_remaining", {}, f"budget-{index}") for index in range(33)]
        + [[LlmTextDelta("任务完成"), LlmStreamCompleted(LlmFinishReason.STOP)]]
    )

    events = [event async for event in runtime_for(context_env, gateway).run(request)]

    assert not [event for event in events if event.type == "failed"]
    assert len(gateway.requests) == 34
    assert (await store.progress(request.run_id)).request_count == 34


async def test_runtime_still_supports_an_explicit_step_limit(context_env) -> None:
    _, store, _, request = context_env
    gateway = ScriptGateway(
        [
            call("get_context_remaining", {}, "budget-1"),
            call("get_context_remaining", {}, "budget-2"),
        ]
    )

    events = [
        event async for event in runtime_for(context_env, gateway, max_steps=2).run(request)
    ]

    assert events[-1].type == "failed"
    assert events[-1].content == "Agent Loop 已达到最大步骤数 2"
    assert len(gateway.requests) == 2
    assert (await store.progress(request.run_id)).request_count == 2


async def test_runtime_checkpoint_rollover_and_history_retrieval(context_env) -> None:
    _, store, _, request = context_env

    def save_checkpoint(completion):
        remaining = json.loads(completion.messages[-1].content)
        return call(
            "write_checkpoint",
            {
                **checkpoint_body(),
                "expected_version": remaining["checkpoint_version"],
                "covered_sequence": remaining["latest_sequence"],
            },
            "checkpoint",
        )

    gateway = ScriptGateway(
        [
            call("write_file", {"path": "result.txt", "content": "done"}, "write"),
            call("get_context_remaining", {}, "budget"),
            save_checkpoint,
            call("new_context", {}, "roll"),
            call("history_search", {"query": "write_file"}, "history"),
            [LlmTextDelta("已完成并验证"), LlmStreamCompleted(LlmFinishReason.STOP)],
        ]
    )
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert not any(event.type == "failed" for event in events)
    assert (await store.window(request.session_id)).number == 2
    assert (await store.checkpoint(request.session_id)).version == 1
    new_messages = gateway.requests[4].messages
    assert sum(getattr(item, "content", "") == request.instruction for item in new_messages) == 1
    assert "不要删除文件" in new_messages[0].content
    assert (Path(request.workspace_path) / "result.txt").read_text() == "done"
    assert (await store.progress(request.run_id)).request_count == 6


async def test_overflow_retries_model_once_without_reexecuting_tools(context_env) -> None:
    _, store, _, request = context_env
    overflow = LlmStreamFailed(
        LlmError(
            LlmErrorCategory.INVALID_REQUEST,
            "context_window_exceeded",
            "too large",
            False,
        )
    )
    gateway = ScriptGateway(
        [
            call("write_file", {"path": "once.txt", "content": "once"}, "write"),
            [LlmTextDelta("失败草稿"), overflow],
            [LlmTextDelta("恢复成功"), LlmStreamCompleted(LlmFinishReason.STOP)],
        ]
    )
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert not any(event.type == "failed" for event in events)
    discarded = [event for event in events if event.type == "model_attempt_discarded"]
    assert discarded[0].payload["discardedChars"] == 4
    assert (await store.window(request.session_id)).number == 2
    assert sum(event.type == "tool_started" for event in events) == 1
    assert (await store.progress(request.run_id)).request_count == 3


async def test_second_overflow_stops_and_does_not_reset_on_restart(context_env) -> None:
    _, store, _, request = context_env
    overflow = LlmStreamFailed(
        LlmError(
            LlmErrorCategory.INVALID_REQUEST,
            "context_window_exceeded",
            "too large",
            False,
        )
    )
    gateway = ScriptGateway([[overflow], [overflow]])
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert events[-1].type == "failed"
    assert len(gateway.requests) == 2
    restarted = ScriptGateway([[overflow]])
    events = [event async for event in runtime_for(context_env, restarted).run(request)]
    assert events[-1].type == "failed"
    assert len(restarted.requests) == 1
    assert (await store.window(request.session_id)).number == 2


async def test_oversized_base_fails_before_provider(context_env) -> None:
    _, _, _, request = context_env
    gateway = ScriptGateway([], capacity=1024)
    with pytest.raises(ContextError, match="context_base_too_large"):
        _ = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert not gateway.requests


async def test_automatic_maintenance_then_rollover(context_env) -> None:
    _, store, artifacts, request = context_env
    state = RunContext(request, store, artifacts, ConservativeTokenCounter(), 32_000)
    messages = await state.initialize()
    # 用预算关系构造压力，避免把当前实现的固定阈值硬编码进用例。
    messages.append(ConversationMessage(MessageRole.ASSISTANT, "x" * 20_000))
    state.budget = ContextBudget(32_000, 4096, 1600, 10_000)
    prepared = await state.prepare(messages, "系统", (), 1)
    assert state.maintenance
    assert state.force_rollover
    assert state.counter.count(prepared) <= state.budget.input_limit
    await state.prepare(list(prepared.messages), "系统", (), 2)
    assert (await store.window(request.session_id)).number == 2


@pytest.mark.parametrize(
    "message,expected",
    [
        ("maximum context length is 100", "context_window_exceeded"),
        ("prompt is too long", "context_window_exceeded"),
        ("invalid tool schema", "provider_rejected_request"),
    ],
)
def test_provider_errors_only_classify_explicit_context_overflow(message, expected) -> None:
    error = ValueError(message)
    error.status_code = 400
    assert classify_provider_error(error).code == expected


async def test_utf8_artifact_pagination_does_not_lose_characters(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "artifacts")
    sid = str(uuid4())
    content = "中文😀混合" * 100
    saved = await store.save(sid, content)
    parts = []
    offset = 0
    while True:
        page = await store.read(sid, saved["artifact_id"], offset, 7)
        parts.append(page["content"])
        if page["next_offset"] is None:
            break
        assert page["next_offset"] > offset
        offset = page["next_offset"]
    assert "".join(parts) == content


async def test_finished_response_recovers_without_another_model_request(context_env) -> None:
    _, store, _, request = context_env
    first = ScriptGateway([[LlmTextDelta("已经完成"), LlmStreamCompleted(LlmFinishReason.STOP)]])
    _ = [event async for event in runtime_for(context_env, first).run(request)]
    assert (await store.progress(request.run_id)).finished
    restarted = ScriptGateway([])
    events = [event async for event in runtime_for(context_env, restarted).run(request)]
    assert not restarted.requests
    assert (
        next(event.content for event in events if event.type == "response_restored") == "已经完成"
    )


async def test_partial_tool_stream_never_executes_side_effects(context_env) -> None:
    _, _, _, request = context_env
    gateway = ScriptGateway(
        [
            [
                LlmToolCallDelta(0, "partial", "write_file", '{"path":"unsafe.txt","content":"x"}'),
            ]
        ]
    )
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert events[-1].type == "failed"
    assert not (Path(request.workspace_path) / "unsafe.txt").exists()


async def test_pending_new_context_is_applied_after_restart(context_env) -> None:
    _, store, artifacts, request = context_env
    await store.record_step(
        request.session_id,
        request.run_id,
        1,
        [
            LlmToolResultMessage("roll", "new_context", '{"new_context_requested":true}'),
        ],
        None,
        0,
    )
    state = RunContext(request, store, artifacts, ConservativeTokenCounter(), 32000)
    messages = await state.initialize()
    assert state.force_rollover
    await state.prepare(messages, "system", (), 2)
    assert (await store.window(request.session_id)).number == 2


async def test_multiple_windows_preserve_constraints_and_history(context_env) -> None:
    _, store, _, request = context_env
    actions = []
    for cycle in range(3):
        actions.extend(
            [
                call("new_context", {}, f"roll-{cycle}"),
                call("history_search", {"query": "不要删除"}, f"search-{cycle}"),
            ]
        )
    actions.append([LlmTextDelta("三次换窗后完成"), LlmStreamCompleted(LlmFinishReason.STOP)])
    gateway = ScriptGateway(actions)
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert not any(event.type == "failed" for event in events)
    assert (await store.window(request.session_id)).number == 4
    for index in (1, 3, 5):
        assert request.instruction in [
            getattr(item, "content", "") for item in gateway.requests[index].messages
        ]
    assert (await store.history(request.session_id, query="不要删除"))["items"]


async def test_rollover_rejects_history_changed_after_snapshot(context_env) -> None:
    _, store, _, request = context_env
    old = await store.window(request.session_id)
    boundary = await store.latest_sequence(request.session_id)
    await store.record_step(
        request.session_id,
        request.run_id,
        1,
        [
            ConversationMessage(MessageRole.ASSISTANT, "边界之后的新事实"),
        ],
        None,
        0,
    )
    with pytest.raises(ContextError, match="context_conflict"):
        await store.rollover(
            request.session_id,
            request.run_id,
            "stale",
            old.id,
            boundary,
            [],
            "test",
        )
    assert (await store.window(request.session_id)).id == old.id


async def test_large_tool_result_is_stored_before_model_projection(context_env) -> None:
    _, store, artifacts, request = context_env
    original = "HEADER\n" + "x" * 150_000 + "\nTAIL"
    path = Path(request.workspace_path) / "large.txt"
    path.write_text(original, encoding="utf-8")
    gateway = ScriptGateway(
        [
            call("read_file", {"path": "large.txt"}, "read-large"),
            [LlmTextDelta("已读取预览"), LlmStreamCompleted(LlmFinishReason.STOP)],
        ]
    )
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert not any(event.type == "failed" for event in events)
    output = json.loads(gateway.requests[1].messages[-1].content)
    assert output["total_bytes"] == len(original)
    assert output["capture_complete"] is True
    assert len(gateway.requests[1].messages[-1].content) < 6000
    tail = await artifacts.read(request.session_id, output["artifact_id"], len(original) - 4)
    assert tail["content"] == "TAIL"
    assert (await store.progress(request.run_id)).finished


async def test_recovery_queue_includes_context_without_tool_calls(context_env) -> None:
    database, store, _, request = context_env
    await store.begin_request(request.run_id, 32)
    conversation = SqliteConversationStore(database.session_factory)
    assert await conversation.recover_incomplete_runs() == 0
    resumable = await conversation.list_resumable_executions()
    assert [str(execution.run.id.value) for execution in resumable] == [request.run_id]


async def test_partial_t1_batch_restores_remaining_calls_and_reuses_t2(context_env) -> None:
    """第二个调用尚未写 T1 就崩溃时，完整批次仍可恢复，第一个 T2 不重放。"""
    database, store, artifacts, request = context_env
    (Path(request.workspace_path) / "second.txt").write_text("second", encoding="utf-8")
    calls = (
        LlmToolCall("first", "read_file", '{"path":"first.txt"}'),
        LlmToolCall("second", "read_file", '{"path":"second.txt"}'),
    )
    await store.begin_request(request.run_id, 32)
    await store.save_pending_step(
        request.run_id,
        PendingContextStep(
            1,
            LlmAssistantToolCallMessage(calls),
            ("read_file",),
        ),
    )
    ledger = SqliteToolExecutionStore(database.session_factory)
    tool = BuiltInToolRegistry(artifacts).get("read_file")
    execution_context = ToolExecutionContext(
        request.session_id,
        request.turn_id,
        request.run_id,
        request.workspace_path,
        request.permission_profile,
    )
    invocation = await ledger.prepare_invocation(
        execution_context,
        calls[0],
        tool.descriptor,
        {"path": "first.txt"},
        step_index=1,
        call_index=0,
        assistant_text="",
    )
    await ledger.mark_running(invocation.id)
    await ledger.finish_invocation(invocation.id, ToolExecutionResult({"content": "cached first"}))
    gateway = ScriptGateway([[LlmTextDelta("完成"), LlmStreamCompleted(LlmFinishReason.STOP)]])
    events = [event async for event in runtime_for(context_env, gateway).run(request)]
    assert not any(event.type == "failed" for event in events)
    results = gateway.requests[0].messages[-2:]
    assert [json.loads(result.content)["content"] for result in results] == [
        "cached first",
        "second",
    ]
    assert sum(event.type == "tool_started" for event in events) == 1
    assert await store.pending_step(request.run_id) is None


async def test_latest_artifact_page_survives_budget_maintenance(context_env) -> None:
    """新读出的正文必须先交给模型，不能为避开维护而再次变成同一个引用。"""
    _, store, artifacts, request = context_env
    state = RunContext(request, store, artifacts, ConservativeTokenCounter(), 20_000)
    messages = await state.initialize()
    saved = await artifacts.save(request.session_id, "正文" * 3000)
    page = await artifacts.read(request.session_id, saved["artifact_id"])
    prepared = await state.prepare(messages, "", (), 1)
    messages.append(ConversationMessage(MessageRole.ASSISTANT, "x"))
    messages.extend(
        [
            LlmAssistantToolCallMessage((LlmToolCall("page", "artifact_read", "{}"),)),
            LlmToolResultMessage("page", "artifact_read", json.dumps(page, ensure_ascii=False)),
        ]
    )
    page_estimate = state.counter.count(replace(prepared, messages=messages))
    padding = state.budget.input_limit - page_estimate - state.budget.maintenance_tokens // 2
    messages[1] = ConversationMessage(MessageRole.ASSISTANT, "x" * padding)
    original = list(messages)
    estimate = state.counter.count(replace(prepared, messages=messages))
    assert 0 <= state.budget.remaining(estimate) <= state.budget.maintenance_tokens

    fitted = await state.fit_tool_results(messages)
    following = await state.prepare(fitted, "", (), 2)

    assert fitted == original
    assert messages == original
    assert state.maintenance
    assert following.messages[-2] == original[-1]
    assert json.loads(following.messages[-2].content)["next_offset"] == page["next_offset"]


async def test_old_results_shrink_without_losing_latest_parallel_pages(context_env) -> None:
    """旧批次可以投影为引用；最新并行批次的每个结果都应保留。"""
    _, store, artifacts, request = context_env
    state = RunContext(request, store, artifacts, ConservativeTokenCounter(), 20_000)
    messages = await state.initialize()
    await state.prepare(messages, "", (), 1)
    messages.extend(
        [
            LlmAssistantToolCallMessage((LlmToolCall("old", "read_file", "{}"),)),
            LlmToolResultMessage("old", "read_file", json.dumps({"content": "x" * 14_000})),
            LlmAssistantToolCallMessage(
                tuple(LlmToolCall(key, "artifact_read", "{}") for key in ("a", "b"))
            ),
            *[
                LlmToolResultMessage(
                    key, "artifact_read", json.dumps({"content": key * 3000, "next_offset": 3000})
                )
                for key in ("a", "b")
            ],
        ]
    )
    original = list(messages)

    fitted = await state.fit_tool_results(messages)

    assert fitted[-3:] == original[-3:]
    assert "artifact_id" in json.loads(fitted[2].content)
    assert messages == original


async def test_latest_page_over_hard_budget_rolls_over_with_history_intact(context_env) -> None:
    """无法保留最新结果时换窗，完整结果仍可从历史读取。"""
    _, store, artifacts, request = context_env
    state = RunContext(request, store, artifacts, ConservativeTokenCounter(), 20_000)
    messages = await state.initialize()
    await state.prepare(messages, "", (), 1)
    batch = [
        LlmAssistantToolCallMessage((LlmToolCall("page", "artifact_read", "{}"),), "x" * 17_000),
        LlmToolResultMessage(
            "page", "artifact_read", json.dumps({"content": "page body", "next_offset": 9})
        ),
    ]
    await store.record_step(request.session_id, request.run_id, 1, batch, None, 0)
    fitted = await state.fit_tool_results(messages + batch)
    assert fitted[-1] == batch[-1]

    following = await state.prepare(fitted, "", (), 2)

    assert (await store.window(request.session_id)).number == 2
    assert state.counter.count(following) <= state.budget.input_limit
    history = await store.read_history(
        request.session_id, await store.latest_sequence(request.session_id)
    )
    assert json.loads(history["content"])["content"] == batch[-1].content


@pytest.mark.parametrize("recovered_success", [True, False])
@pytest.mark.parametrize("cached_result", [True, False])
async def test_recovery_updates_failure_streak(
    context_env, recovered_success, cached_result
) -> None:
    """恢复的成功要清零、第三次失败要停止；复用 T2 和补执行都遵守同一规则。"""
    database, store, artifacts, request = context_env
    args = {"path": "missing.txt"}
    encoded = json.dumps(args, sort_keys=True, separators=(",", ":"))
    signature = f"read_file:{encoded}"
    for step in (1, 2):
        await store.record_step(
            request.session_id,
            request.run_id,
            step,
            [
                LlmAssistantToolCallMessage((LlmToolCall(f"failed-{step}", "read_file", encoded),)),
                LlmToolResultMessage(f"failed-{step}", "read_file", '{"error":"missing"}', True),
            ],
            signature,
            step,
        )

    name = "get_context_remaining" if recovered_success else "read_file"
    arguments = {} if recovered_success else args
    pending_call = LlmToolCall("recover", name, json.dumps(arguments))
    await store.save_pending_step(
        request.run_id,
        PendingContextStep(
            3,
            LlmAssistantToolCallMessage((pending_call,)),
            (name,),
        ),
    )
    if cached_result:
        registry = ContextToolRegistry(
            BuiltInToolRegistry(artifacts),
            RunContext(
                request,
                store,
                artifacts,
                ConservativeTokenCounter(),
                32_000,
            ),
        )
        ledger = SqliteToolExecutionStore(database.session_factory)
        context = ToolExecutionContext(
            request.session_id,
            request.turn_id,
            request.run_id,
            request.workspace_path,
            request.permission_profile,
        )
        invocation = await ledger.prepare_invocation(
            context,
            pending_call,
            registry.get(name).descriptor,
            arguments,
            step_index=3,
            call_index=0,
            assistant_text="",
        )
        await ledger.mark_running(invocation.id)
        await ledger.finish_invocation(
            invocation.id,
            ToolExecutionResult(
                {"cached": True},
                is_error=not recovered_success,
            ),
        )

    actions = []
    if recovered_success:
        actions.append(call("read_file", args, "later-failure"))
    actions.append([LlmTextDelta("完成"), LlmStreamCompleted(LlmFinishReason.STOP)])
    gateway = ScriptGateway(actions)
    runtime = runtime_for(context_env, gateway)
    events = [event async for event in runtime.run(request)]
    progress = await store.progress(request.run_id)

    assert progress.failure_count == (1 if recovered_success else 3)
    assert len(gateway.requests) == (2 if recovered_success else 0)
    assert any(event.type == "failed" for event in events) is (not recovered_success)
    assert await store.pending_step(request.run_id) is None
    if not recovered_success:
        restarted = ScriptGateway([])
        events = [event async for event in runtime_for(context_env, restarted).run(request)]
        assert events[-1].type == "failed"
        assert not restarted.requests
