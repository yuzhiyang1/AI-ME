"""验证桥接关联、连接排他、取消撤销和重连隔离。"""

import asyncio

import pytest

from aime.domain.browser import BrowserConflict, BrowserError, BrowserUnavailable
from aime.infrastructure.browser_bridge import DesktopBrowserBridge


async def test_bridge_correlates_out_of_order_replies_and_ignores_duplicates():
    bridge = DesktopBrowserBridge()
    messages = asyncio.Queue()
    connection = bridge.attach(messages.put)
    with pytest.raises(BrowserConflict):
        bridge.attach(messages.put)
    first = asyncio.create_task(bridge.request("session", "observe", {}, connection_id=connection))
    second = asyncio.create_task(bridge.request("session", "close", {}, connection_id=connection))
    a, b = await messages.get(), await messages.get()
    bridge.receive(connection, {"id": b["id"], "result": {"second": True}})
    bridge.receive(connection, {"id": a["id"], "result": {"first": True}})
    bridge.receive(connection, {"id": a["id"], "result": {"duplicate": True}})
    assert await first == {"first": True}
    assert await second == {"second": True}
    bridge.detach(connection)


async def test_disconnect_fails_pending_request_and_old_connection_cannot_finish_new_one():
    bridge = DesktopBrowserBridge()
    messages = asyncio.Queue()
    old = bridge.attach(messages.put)
    pending = asyncio.create_task(bridge.request("s", "observe", {}, connection_id=old))
    await messages.get()
    bridge.detach(old)
    with pytest.raises(BrowserUnavailable):
        await pending
    new = bridge.attach(messages.put)
    pending = asyncio.create_task(bridge.request("s", "observe", {}, connection_id=new))
    message = await messages.get()
    bridge.detach(old)
    bridge.receive(old, {"id": message["id"], "result": {"old": True}})
    assert not pending.done()
    bridge.receive(new, {"id": message["id"], "result": {"new": True}})
    assert await pending == {"new": True}
    bridge.detach(new)


@pytest.mark.parametrize("expires", [False, True])
async def test_cancel_or_timeout_sends_revocation_with_original_run_id(expires):
    bridge = DesktopBrowserBridge(timeout=0.02 if expires else 30, cancel_timeout=0.2)
    messages = asyncio.Queue()
    connection = bridge.attach(messages.put)
    task = asyncio.create_task(bridge.request(
        "session", "act", {"runId": "run-1", "actionId": "a", "snapshotId": "s"},
        connection_id=connection,
    ))
    original = await messages.get()
    if not expires:
        task.cancel()
    cancel = await asyncio.wait_for(messages.get(), 1)
    assert cancel["operation"] == "cancel"
    assert cancel["arguments"] == {"requestId": original["id"], "runId": "run-1"}
    bridge.receive(connection, {"id": cancel["id"], "result": {}})
    with pytest.raises(BrowserUnavailable if expires else asyncio.CancelledError):
        await task
    assert not bridge._pending
    bridge.detach(connection)


async def test_cancel_ack_timeout_has_explicit_uncertain_result():
    bridge = DesktopBrowserBridge(timeout=0.01, cancel_timeout=0.01)
    connection = bridge.attach(asyncio.Queue().put)
    with pytest.raises(BrowserUnavailable, match="结果不确定"):
        await bridge.request("s", "act", {"runId": "r"}, connection_id=connection)
    assert not bridge._pending
    bridge.detach(connection)


@pytest.mark.parametrize("message", [
    [], {}, {"id": "bad/id", "result": {}}, {"id": "a", "result": {}, "error": "bad"},
    {"id": "a", "result": []}, {"id": "a", "error": 7},
])
async def test_malformed_bridge_reply_is_rejected(message):
    bridge = DesktopBrowserBridge()
    connection = bridge.attach(asyncio.Queue().put)
    with pytest.raises(BrowserError):
        bridge.receive(connection, message)
    bridge.detach(connection)
