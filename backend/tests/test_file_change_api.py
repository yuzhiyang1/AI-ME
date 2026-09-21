"""通过真实工具、账本和 HTTP 接口验收差异持久化；模型调用使用确定性替身。"""

import json
import time
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
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


class FileChangeGateway:
    """依次新增、覆盖、编辑同一文件，检查展示差异没有进入模型上下文。"""

    def __init__(self, prefix: str = "user-local") -> None:
        self.calls = 0
        self.prefix = prefix

    def list_models(self) -> list[ModelDescriptor]:
        # 本用例验证大差异投影，不让固定模型脚本误闯预算维护阶段。
        return [ModelDescriptor("qa", "diff-model", "差异验收模型", 128000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        for message in request.messages:
            if isinstance(message, LlmToolResultMessage):
                assert "file_change" not in json.loads(message.content)
        operations = [
            ("write_file", {"path": "demo.txt", "content": f"{self.prefix}\nold\n"}),
            (
                "write_file",
                {"path": "demo.txt", "content": f"{self.prefix}\nsecond\n", "overwrite": True},
            ),
            ("edit_file", {"path": "demo.txt", "old_text": "second", "new_text": "final"}),
        ]
        index = self.calls
        self.calls += 1
        yield LlmStreamStarted()
        if index < len(operations):
            name, arguments = operations[index]
            assert name in {tool.name for tool in request.tools}
            yield LlmToolCallDelta(0, f"diff-call-{index}", name, json.dumps(arguments))
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
        else:
            yield LlmTextDelta("差异验收完成")
            yield LlmStreamCompleted(LlmFinishReason.STOP)


@pytest.mark.parametrize("prefix", ["user-local", "x" * 8000], ids=["small-diff", "large-diff"])
def test_file_change_survives_reload_and_restart(tmp_path: Path, prefix: str) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state = tmp_path / "state"
    gateway = FileChangeGateway(prefix)
    with TestClient(create_app(build_container(state_dir=state, model_gateway=gateway))) as client:
        response = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/diff-model",
                "permissionProfile": "full_access",
            },
        )
        assert response.status_code == 201
        session_id = response.json()["id"]
        response = client.post(
            f"/api/sessions/{session_id}/turns",
            json={
                "input": "差异测试",
                "clientRequestId": "file-diff-acceptance",
            },
        )
        assert response.status_code == 202
        for _ in range(500):
            # 覆盖仍需明确审批；通过真实审批接口继续，不绕过工具安全策略。
            for approval in client.get(f"/api/sessions/{session_id}/approvals").json():
                decided = client.post(
                    f"/api/sessions/{session_id}/approvals/{approval['id']}/decision",
                    json={"decision": "approve_once"},
                )
                assert decided.status_code == 200
            if client.get(f"/api/sessions/{session_id}").json()["activity"] == "idle":
                break
            time.sleep(0.01)
        assert gateway.calls == 4
        usage = client.get(f"/api/sessions/{session_id}/usage").json()
        assert usage["contextEstimated"] is True
        assert usage["currentContextTokens"] > 0
        # 大差异场景可能触发自动换窗；账本与界面差异必须跨窗口保留。
        assert usage["windowNumber"] >= 1
        invocations = client.get(f"/api/sessions/{session_id}/tool-invocations").json()
        assert len(invocations) == 3
        assert all(item["status"] == "completed" for item in invocations)
        changes = [item["result"]["file_change"] for item in invocations]
        assert [change["operation"] for change in changes] == ["create", "modify", "modify"]
        assert changes[0]["deletions"] == 0
        assert changes[1]["additions"] == changes[1]["deletions"] == 1
        assert changes[2]["hunks"][0]["lines"] == [f" {prefix}", "-second", "+final"]

    # 重启和手工改文件后，HTTP 仍返回执行当时落账的差异。
    (workspace / "demo.txt").write_text("later manual edit", encoding="utf-8")
    with TestClient(create_app(build_container(state_dir=state, model_gateway=gateway))) as client:
        restored = client.get(f"/api/sessions/{session_id}/tool-invocations").json()
        assert [item["result"]["file_change"] for item in restored] == changes
