"""浏览器工具注册、真实桥消息和按站点授权的回归测试。"""

import asyncio

import pytest

from aime.application.ports.tool_execution import ToolExecutionContext
from aime.domain.sessions.value_objects import PermissionProfile
from aime.domain.tool_execution.browser_scope import browser_origin, tool_grant_scope
from aime.infrastructure.browser_bridge import DesktopBrowserBridge
from aime.infrastructure.runtime.model_agent_runtime import _approval_reason
from aime.infrastructure.tools.browser_tools import BrowserToolRegistry
from aime.infrastructure.tools.builtin import BuiltInToolRegistry


def context(permission=PermissionProfile.WORKSPACE_WRITE):
    return ToolExecutionContext("session", "turn", "run", ".", permission, call_id="call")


def test_six_tools_compose_with_existing_registry_and_hide_in_readonly():
    registry = BrowserToolRegistry(BuiltInToolRegistry(), DesktopBrowserBridge())
    names = {
        item.definition.name for item in registry.descriptors(PermissionProfile.WORKSPACE_WRITE)
    }
    assert names >= {
        "read_file",
        "run_powershell",
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_wait",
        "browser_extract",
    }
    assert not any(
        item.definition.name.startswith("browser_")
        for item in registry.descriptors(PermissionProfile.READ_ONLY)
    )


async def test_agent_identity_and_credential_reference_travel_through_authenticated_bridge():
    bridge = DesktopBrowserBridge()
    messages = asyncio.Queue()
    connection = bridge.attach(messages.put)
    tool = BrowserToolRegistry(BuiltInToolRegistry(), bridge).get("browser_type")
    call = asyncio.create_task(
        tool.execute(
            {"origin": "https://example.com", "ref": "#password", "credential": "test-password"},
            context(),
        )
    )
    command = await messages.get()
    assert command["sessionId"] == "session"
    assert command["operation"] == "tool"
    assert command["arguments"] == {
        "name": "type",
        "origin": "https://example.com",
        "args": {
            "origin": "https://example.com",
            "ref": "#password",
            "credential": "test-password",
        },
        "turnId": "turn",
        "callId": "call",
    }
    bridge.receive(connection, {"id": command["id"], "result": {"verified": True}})
    assert not (await call).is_error
    bridge.detach(connection)


async def test_disconnected_readonly_and_ambiguous_type_fail_without_dispatch():
    bridge = DesktopBrowserBridge()
    tool = BrowserToolRegistry(BuiltInToolRegistry(), bridge).get("browser_type")
    assert (await tool.execute({}, context())).is_error
    messages = asyncio.Queue()
    connection = bridge.attach(messages.put)
    args = {
        "origin": "https://example.com",
        "ref": "#password",
        "text": "test",
        "credential": "ref",
    }
    assert (await tool.execute(args, context())).is_error
    assert (await tool.execute(args, context(PermissionProfile.READ_ONLY))).is_error
    assert messages.empty()
    bridge.detach(connection)


def test_site_grant_shared_by_six_tools_but_never_by_another_origin():
    grant = tool_grant_scope("browser_navigate", {"url": "https://EXAMPLE.com:443/login"})
    assert grant == tool_grant_scope("browser_click", {"origin": "https://example.com"})
    assert grant != tool_grant_scope("browser_click", {"origin": "https://elsewhere.example"})
    assert "跨站" in _approval_reason("browser_navigate", {"url": "https://example.com"})
    assert tool_grant_scope("read_file", {}) == "read_file"


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp/test",
        "javascript:alert(1)",
        "https://user:pass@example.com",
        "https://example.com:bad",
        None,
    ],
)
def test_invalid_origins_rejected(url):
    with pytest.raises(ValueError):
        browser_origin(url)
