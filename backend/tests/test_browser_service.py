"""浏览器纵向切片异步测试：真实 SQLite/装配，仅模型和桌面桥消息使用替身。"""

import asyncio
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from aime.application.ports.model_gateway import (
    LlmFinishReason,
    LlmStreamCompleted,
    LlmTextDelta,
    ModelDescriptor,
)
from aime.application.sessions.commands import CreateSessionCommand
from aime.application.sessions.services import SessionNotFound
from aime.composition import build_container
from aime.domain.browser import BrowserConflict, BrowserDecision, BrowserRun, BrowserStatus
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.persistence.sqlite_browser_run_repository import SqliteBrowserRunRepository


class Credentials:
    """所有测试都用内存凭据，不访问用户的系统密钥。"""

    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value):
        self.values[key] = value

    async def delete(self, key):
        self.values.pop(key, None)


class TextGateway:
    def list_models(self):
        return [ModelDescriptor("test", "text", "文字模型", 128000)]

    async def stream(self, request):
        yield LlmTextDelta('{"text":"Jev browser test"}')
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class Planner:
    def __init__(self):
        self.model = "jev-test"
        self.configured = False
        self.calls = 0
        self.delay = False
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.decision = BrowserDecision("CLICK", "search", 1, 1)

    def configure(self, model, api_key):
        self.model, self.configured = model, bool(api_key)

    async def choose(self, snapshot, goal, history):
        self.calls += 1
        self.started.set()
        if self.delay:
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled.set()
        return self.decision


@dataclass
class Harness:
    container: object
    planner: Planner
    session_id: UUID
    connection_id: str
    messages: list
    state: Path
    credentials: Credentials
    uncertain: bool = False


@pytest.fixture
async def harness(tmp_path, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    planner, credentials = Planner(), Credentials()
    container = build_container(
        state_dir=tmp_path / "state", browser_planner=planner,
        model_gateway=TextGateway(), model_credential_store=credentials,
    )
    await container.initialize()
    await container.browser_service.save_config("jev-test", "fake-key", False)
    session = await container.create_session.execute(CreateSessionCommand(
        str(tmp_path), "test/text", PermissionProfile.READ_ONLY,
    ))
    messages = []
    h = Harness(container, planner, session.id.value, "", messages, tmp_path / "state", credentials)

    async def send(message):
        messages.append(message)
        result = {"ok": True}
        if message["operation"] == "observe":
            result = {"snapshotId": f"snapshot-{len(messages)}", "url": "https://fixture.test",
                      "title": "Search", "text": "Search", "actions": [
                          {"id": "search", "kind": "click", "label": "Search"},
                      ]}
        elif message["operation"] == "act" and h.uncertain:
            result = {"outcome": "uncertain"}
        container.browser_bridge.receive(h.connection_id, {"id": message["id"], "result": result})

    h.connection_id = container.browser_bridge.attach(send)
    try:
        yield h
    finally:
        await container.close()


async def wait_status(harness, run, status):
    async with asyncio.timeout(3):
        while run.status != status:
            assert run.status not in (BrowserStatus.FAILED, BrowserStatus.STOPPED), run.error
            await asyncio.sleep(0.005)
    return run


async def settle(harness, run):
    await harness.container.browser_service._executions[run.session_id].task


async def test_real_session_required_and_concurrent_duplicate_start_is_rejected(harness):
    service = harness.container.browser_service
    with pytest.raises(SessionNotFound):
        await service.start(uuid4(), "Search")
    results = await asyncio.gather(
        service.start(harness.session_id, "Search"), service.start(harness.session_id, "Search"),
        return_exceptions=True,
    )
    assert sum(isinstance(value, BrowserRun) for value in results) == 1
    assert sum(isinstance(value, BrowserConflict) for value in results) == 1


async def test_approval_cannot_be_replayed_for_next_action(harness):
    service = harness.container.browser_service
    run = await service.start(harness.session_id, "Search")
    await wait_status(harness, run, BrowserStatus.AWAITING_APPROVAL)
    assert not [m for m in harness.messages if m["operation"] == "act"]
    first_id = run.pending_action["approvalId"]
    service.approve(harness.session_id, UUID(run.id), True, first_id)
    assert run.status == BrowserStatus.RUNNING and run.pending_action is None
    with pytest.raises(BrowserConflict):
        service.approve(harness.session_id, UUID(run.id), True, first_id)
    await wait_status(harness, run, BrowserStatus.AWAITING_APPROVAL)
    assert run.pending_action["approvalId"] != first_id
    with pytest.raises(BrowserConflict):
        service.approve(harness.session_id, UUID(run.id), True, first_id)
    assert len([m for m in harness.messages if m["operation"] == "act"]) == 1
    await service.stop(harness.session_id, UUID(run.id))
    assert all(m["arguments"]["runId"] == run.id for m in harness.messages)
    assert run.status == BrowserStatus.STOPPED


async def test_stop_cancels_inflight_model_and_awaiting_approval(harness):
    harness.planner.delay = True
    service = harness.container.browser_service
    run = await service.start(harness.session_id, "Search")
    await asyncio.wait_for(harness.planner.started.wait(), 1)
    await service.stop(harness.session_id, UUID(run.id))
    assert harness.planner.cancelled.is_set()
    assert not [m for m in harness.messages if m["operation"] == "act"]
    harness.planner.delay = False
    run = await service.start(harness.session_id, "Search again")
    await wait_status(harness, run, BrowserStatus.AWAITING_APPROVAL)
    await service.stop(harness.session_id, UUID(run.id))
    assert run.pending_action is None
    assert not [m for m in harness.messages if m["operation"] == "act"]


async def test_disconnect_cancels_model_even_without_pending_bridge_request(harness):
    harness.planner.delay = True
    run = await harness.container.browser_service.start(harness.session_id, "Search")
    await harness.planner.started.wait()
    harness.container.browser_bridge.detach(harness.connection_id)
    await settle(harness, run)
    assert run.status == BrowserStatus.FAILED
    assert harness.planner.cancelled.is_set()


async def test_uncertain_action_stops_immediately_for_verification(harness):
    harness.uncertain = True
    run = await harness.container.browser_service.start(
        harness.session_id, "Search", confirm_each_action=False,
    )
    await settle(harness, run)
    assert run.status == BrowserStatus.NEEDS_VERIFICATION
    assert run.steps[0]["status"] == "uncertain"
    assert harness.planner.calls == 1
    assert len(harness.messages) == 2


async def test_done_and_low_target_confidence_never_execute(harness):
    service = harness.container.browser_service
    harness.planner.decision = BrowserDecision("DONE", None, 1)
    run = await service.start(harness.session_id, "Verify")
    await settle(harness, run)
    assert run.status == BrowserStatus.NEEDS_VERIFICATION
    harness.planner.decision = BrowserDecision("CLICK", "search", 0.9, 0.2)
    run = await service.start(harness.session_id, "Search")
    await settle(harness, run)
    assert run.status == BrowserStatus.BLOCKED
    assert not [m for m in harness.messages if m["operation"] == "act"]


async def test_run_limit_timeout_and_running_config_conflict(harness):
    service = harness.container.browser_service
    service._max_active = 1
    service._run_timeout = 0.1
    harness.planner.delay = True
    run = await service.start(harness.session_id, "Search")
    with pytest.raises(BrowserConflict):
        await service.save_config("other", "key", False)
    other = await harness.container.create_session.execute(CreateSessionCommand(
        str(harness.state.parent), "test/text", PermissionProfile.READ_ONLY,
    ))
    with pytest.raises(BrowserConflict):
        await service.start(other.id.value, "other")
    await settle(harness, run)
    assert run.status == BrowserStatus.FAILED and "超时" in run.error
    assert harness.planner.cancelled.is_set()


async def test_run_steps_are_persisted_and_restart_never_resumes(harness):
    service = harness.container.browser_service
    run = await service.start(harness.session_id, "Search", max_steps=1, confirm_each_action=False)
    await settle(harness, run)
    with sqlite3.connect(harness.state / "ai-me.db") as database:
        saved = json.loads(database.execute(
            "SELECT payload FROM browser_runs WHERE id=?", (run.id,),
        ).fetchone()[0])
    assert saved["steps"][0]["status"] == "executed"
    repository = SqliteBrowserRunRepository(harness.container.database.session_factory)
    interrupted = BrowserRun(str(uuid4()), str(harness.session_id), "crashed")
    await repository.save(interrupted)
    await repository.recover()
    recovered = await repository.current(str(harness.session_id))
    assert recovered.status == BrowserStatus.STOPPED
    assert "重启" in recovered.error


async def test_configuration_clear_survives_restart_and_never_falls_back(harness, monkeypatch):
    service = harness.container.browser_service
    await service.save_config("saved-model", None, True)
    assert not service.config()["configured"]
    assert not harness.credentials.values
    monkeypatch.setenv("TYPESAFE_API_KEY", "must-not-reactivate")
    restarted = build_container(
        state_dir=harness.state, browser_planner=Planner(), model_gateway=TextGateway(),
        model_credential_store=harness.credentials,
    )
    await restarted.initialize()
    try:
        assert restarted.browser_service.config()["configured"] is False
        assert restarted.browser_service.config()["model"] == "saved-model"
        assert [m.ref for m in restarted.list_available_models.execute()] == ["test/text"]
    finally:
        await restarted.close()


async def test_reject_approval_has_no_side_effect(harness):
    service = harness.container.browser_service
    run = await service.start(harness.session_id, "Search")
    await wait_status(harness, run, BrowserStatus.AWAITING_APPROVAL)
    service.approve(harness.session_id, UUID(run.id), False, run.pending_action["approvalId"])
    await settle(harness, run)
    assert run.status == BrowserStatus.STOPPED
    assert not [m for m in harness.messages if m["operation"] == "act"]
