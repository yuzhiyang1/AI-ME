"""通过公开 API 验证危险工具审批与继续执行。"""

import json
import time
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamStarted,
    LlmTextDelta,
    LlmToolCallDelta,
    LlmToolResultMessage,
    ModelDescriptor,
)
from aime.composition import build_container
from aime.main import create_app


def _wait_for_finished_items(client: TestClient, session_id: str) -> list[dict[str, object]]:
    """给真实 PowerShell 冷启动留出余量；必须在关闭应用前读到持久化结果。"""
    deadline = time.monotonic() + 15
    items: list[dict[str, object]] = []
    while time.monotonic() < deadline:
        items = client.get(f"/api/sessions/{session_id}/items").json()
        if len(items) == 2:
            return items
        time.sleep(0.05)
    raise AssertionError(f"15 秒内没有收到本轮终态消息，实际消息：{items}")


def _wait_for_idle(client: TestClient, session_id: str, *, no_approval: bool = False) -> None:
    """上一轮真正结束后才能开始下一轮，并持续验证复用授权没有再次请求审批。"""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if no_approval:
            assert client.get(f"/api/sessions/{session_id}/approvals").json() == []
        if client.get(f"/api/sessions/{session_id}").json()["activity"] == "idle":
            return
        time.sleep(0.05)
    raise AssertionError("15 秒内会话未回到 idle 状态")


class _PowerShellGateway:
    """请求一次需要审批的 PowerShell，再返回最终回答。"""

    def __init__(self) -> None:
        self.requests: list[LlmCompletionRequest] = []

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.requests.append(request)
        yield LlmStreamStarted()
        if len(self.requests) == 1:
            command = "Set-Content -LiteralPath marker.txt -Value approved -NoNewline"
            yield LlmToolCallDelta(
                0,
                "call-shell",
                "run_powershell",
                json.dumps({"command": command}),
            )
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
            return
        result = request.messages[-1]
        assert isinstance(result, LlmToolResultMessage)
        assert json.loads(result.content)["exit_code"] == 0
        yield LlmTextDelta("命令已经执行完成")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _RejectedPowerShellGateway(_PowerShellGateway):
    """用户拒绝后读取工具错误并正常结束当前 Turn。"""

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        if len(self.requests) == 0:
            async for event in super().stream(request):
                yield event
            return
        self.requests.append(request)
        result = request.messages[-1]
        assert isinstance(result, LlmToolResultMessage)
        assert json.loads(result.content)["error"]["code"] == "approval_rejected"
        yield LlmStreamStarted()
        yield LlmTextDelta("已按你的决定取消命令")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _TwoTurnPowerShellGateway:
    """连续两个 Turn 都请求 PowerShell，用于验证 Session 级授权。"""

    def __init__(self) -> None:
        self.requests: list[LlmCompletionRequest] = []

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.requests.append(request)
        yield LlmStreamStarted()
        if len(self.requests) in {1, 3}:
            turn_number = 1 if len(self.requests) == 1 else 2
            command = (
                f"Set-Content -LiteralPath marker-{turn_number}.txt -Value {turn_number} -NoNewline"
            )
            yield LlmToolCallDelta(
                0,
                f"call-shell-{turn_number}",
                "run_powershell",
                json.dumps({"command": command}),
            )
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
            return
        yield LlmTextDelta("完成")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


def test_user_can_approve_a_shell_call_once_and_runtime_continues(tmp_path: Path) -> None:
    """审批前不得产生副作用；批准后应继续原 Run，而不是重新调用第一步模型。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _PowerShellGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "创建 marker.txt", "clientRequestId": "approval-shell"},
        )

        approvals: list[dict[str, object]] = []
        for _ in range(200):
            approvals = client.get(f"/api/sessions/{session_id}/approvals").json()
            if approvals:
                break
            time.sleep(0.01)
        assert len(approvals) == 1
        assert approvals[0]["toolName"] == "run_powershell"
        assert approvals[0]["status"] == "pending"
        assert not (workspace / "marker.txt").exists()
        assert client.get(f"/api/sessions/{session_id}").json()["activity"] == "waiting_for_user"

        decided = client.post(
            f"/api/sessions/{session_id}/approvals/{approvals[0]['id']}/decision",
            json={"decision": "approve_once"},
        )
        assert decided.status_code == 200

        items = _wait_for_finished_items(client, session_id)

    assert (workspace / "marker.txt").read_text(encoding="utf-8") == "approved"
    assert len(gateway.requests) == 2
    assert items[-1]["content"] == {"text": "命令已经执行完成"}


def test_pending_approval_survives_restart_without_regenerating_the_tool_call(
    tmp_path: Path,
) -> None:
    """重启后应恢复原调用和审批，不能再次请求模型生成第一步。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_dir = tmp_path / "state"
    gateway = _PowerShellGateway()

    with TestClient(
        create_app(build_container(state_dir=state_dir, model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "创建 marker.txt", "clientRequestId": "approval-restart"},
        )
        for _ in range(200):
            pending = client.get(f"/api/sessions/{session_id}/approvals").json()
            if pending:
                break
            time.sleep(0.01)
        approval_id = pending[0]["id"]
        assert len(gateway.requests) == 1

    with TestClient(
        create_app(build_container(state_dir=state_dir, model_gateway=gateway))
    ) as reopened:
        pending_after_restart = reopened.get(f"/api/sessions/{session_id}/approvals").json()
        assert pending_after_restart[0]["id"] == approval_id
        reopened.post(
            f"/api/sessions/{session_id}/approvals/{approval_id}/decision",
            json={"decision": "approve_once"},
        )
        items = _wait_for_finished_items(reopened, session_id)

    assert len(gateway.requests) == 2
    assert (workspace / "marker.txt").read_text(encoding="utf-8") == "approved"
    assert items[-1]["type"] == "agent_message"


def test_rejected_shell_call_has_no_side_effect_and_model_can_finish(tmp_path: Path) -> None:
    """拒绝应作为工具错误回填模型，同时禁止命令产生任何文件。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _RejectedPowerShellGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "创建 marker.txt", "clientRequestId": "approval-reject"},
        )
        for _ in range(200):
            approvals = client.get(f"/api/sessions/{session_id}/approvals").json()
            if approvals:
                break
            time.sleep(0.01)
        client.post(
            f"/api/sessions/{session_id}/approvals/{approvals[0]['id']}/decision",
            json={"decision": "reject"},
        )
        items = _wait_for_finished_items(client, session_id)

    assert not (workspace / "marker.txt").exists()
    assert items[-1]["content"] == {"text": "已按你的决定取消命令"}


def test_approve_session_skips_the_same_tool_approval_for_later_turns(tmp_path: Path) -> None:
    """本会话允许应持久生效，但只匹配同一工具。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _TwoTurnPowerShellGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "第一条命令", "clientRequestId": "approval-session-1"},
        )
        for _ in range(200):
            approvals = client.get(f"/api/sessions/{session_id}/approvals").json()
            if approvals:
                break
            time.sleep(0.01)
        client.post(
            f"/api/sessions/{session_id}/approvals/{approvals[0]['id']}/decision",
            json={"decision": "approve_session"},
        )
        _wait_for_idle(client, session_id)

        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "第二条命令", "clientRequestId": "approval-session-2"},
        )
        _wait_for_idle(client, session_id, no_approval=True)

    assert (workspace / "marker-1.txt").read_text(encoding="utf-8") == "1"
    assert (workspace / "marker-2.txt").read_text(encoding="utf-8") == "2"
    assert len(gateway.requests) == 4


def test_interrupting_a_waiting_turn_closes_its_pending_approval(tmp_path: Path) -> None:
    """Run 进入终态后不得留下仍可批准的危险调用。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _PowerShellGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        turn = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "创建 marker.txt", "clientRequestId": "interrupt-approval"},
        ).json()
        for _ in range(200):
            approvals = client.get(f"/api/sessions/{session_id}/approvals").json()
            if approvals:
                break
            time.sleep(0.01)

        interrupted = client.post(f"/api/sessions/{session_id}/turns/{turn['id']}/interrupt")

        assert interrupted.status_code == 204
        assert client.get(f"/api/sessions/{session_id}/approvals").json() == []
        assert client.get(f"/api/sessions/{session_id}").json()["activity"] == "idle"

    assert not (workspace / "marker.txt").exists()
