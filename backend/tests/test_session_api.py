"""通过公开 HTTP 接口验证 Agent Session 纵向切片。"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamStarted,
    LlmTextDelta,
    LlmUsage,
    ModelDescriptor,
)
from aime.composition import build_container
from aime.main import create_app


class _GreetingModelGateway:
    """测试用确定性模型，避免依赖真实厂商和网络。"""

    def __init__(self) -> None:
        self.call_count = 0

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("openai", "gpt-5", "GPT-5", 128_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        assert request.model_ref == "openai/gpt-5"
        assert request.messages[-1].content == "你好"
        yield LlmStreamStarted()
        yield LlmTextDelta("你")
        yield LlmTextDelta("好！")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _SlowModelGateway(_GreetingModelGateway):
    """让首个 Turn 保持活跃，便于验证单会话并发规则。"""

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        yield LlmStreamStarted()
        await asyncio.sleep(0.2)
        yield LlmTextDelta("完成")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _EmptyModelGateway(_GreetingModelGateway):
    """模拟模型正常结束但没有返回任何正文。"""

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        yield LlmStreamStarted()
        yield LlmStreamCompleted(LlmFinishReason.CONTENT_FILTER)


class _HistoryModelGateway(_GreetingModelGateway):
    """记录模型请求，用于确认后续 Turn 收到完整会话历史。"""

    def __init__(self) -> None:
        super().__init__()
        self.requests: list[LlmCompletionRequest] = []

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        self.requests.append(request)
        yield LlmStreamStarted()
        yield LlmTextDelta("第一答" if self.call_count == 1 else "第二答")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _UsageModelGateway(_GreetingModelGateway):
    """为连续两轮返回不同用量，验证累计消耗与当前上下文口径。"""

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.call_count += 1
        usage = (
            LlmUsage(input_tokens=12_000, output_tokens=800)
            if self.call_count == 1
            else LlmUsage(input_tokens=18_000, output_tokens=1_200)
        )
        yield LlmStreamStarted()
        yield LlmTextDelta(f"第 {self.call_count} 次回答")
        yield LlmStreamCompleted(LlmFinishReason.STOP, usage=usage)


def test_user_can_reopen_a_persisted_session(tmp_path: Path) -> None:
    """创建的 Session 必须在后端进程重新装配后仍然可读。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_dir = tmp_path / "state"

    with TestClient(create_app(build_container(state_dir=state_dir))) as client:
        created = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        )

    assert created.status_code == 201
    session_id = created.json()["id"]

    # 重新创建整个依赖容器，模拟关闭并重启 AI-ME。
    with TestClient(create_app(build_container(state_dir=state_dir))) as reopened_client:
        reopened = reopened_client.get(f"/api/sessions/{session_id}")

    assert reopened.status_code == 200
    assert reopened.json() == {
        "id": session_id,
        "title": "新任务",
        "projectId": None,
        "workspacePath": str(workspace.resolve()),
        "workspaceRoots": [str(workspace.resolve())],
        "defaultModel": "openai/gpt-5",
        "permissionProfile": "workspace_write",
        "lifecycle": "active",
        "activity": "idle",
        "pinned": False,
        "createdAt": reopened.json()["createdAt"],
        "updatedAt": reopened.json()["updatedAt"],
    }


def test_project_session_snapshots_all_project_roots(tmp_path: Path) -> None:
    """项目会话复制创建瞬间的完整 roots，并以第一项作为主目录。"""
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    primary.mkdir()
    secondary.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        project = client.post(
            "/api/projects",
            json={
                "name": "AI-ME",
                "roots": [{"path": str(primary)}, {"path": str(secondary)}],
                "idempotencyKey": "session-project",
            },
        ).json()
        created = client.post(
            "/api/sessions",
            json={
                "projectId": project["id"],
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        )

    assert created.status_code == 201
    assert created.json()["projectId"] == project["id"]
    assert created.json()["workspacePath"] == str(primary.resolve())
    assert created.json()["workspaceRoots"] == [
        str(primary.resolve()),
        str(secondary.resolve()),
    ]


def test_standalone_session_has_no_project_and_one_root(tmp_path: Path) -> None:
    """独立会话仍要求用户选择目录，并形成单 root 运行快照。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        created = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        )

    assert created.status_code == 201
    assert created.json()["projectId"] is None
    assert created.json()["workspaceRoots"] == [str(workspace.resolve())]


def test_session_rejects_ambiguous_or_missing_workspace_source(tmp_path: Path) -> None:
    """项目来源和独立目录必须二选一，不能让运行目录语义含糊。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        project = client.post(
            "/api/projects",
            json={
                "name": "AI-ME",
                "roots": [{"path": str(workspace)}],
                "idempotencyKey": "exclusive-source",
            },
        ).json()
        ambiguous = client.post(
            "/api/sessions",
            json={
                "projectId": project["id"],
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        )
        missing = client.post(
            "/api/sessions",
            json={
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        )

    assert ambiguous.status_code == 422
    assert missing.status_code == 422


def test_project_edit_and_delete_do_not_change_existing_session_snapshot(
    tmp_path: Path,
) -> None:
    """项目只是创建模板；编辑或删除后，已有 Session 的 roots 与历史仍保持。"""
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    replacement = tmp_path / "replacement"
    primary.mkdir()
    secondary.mkdir()
    replacement.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        project = client.post(
            "/api/projects",
            json={
                "name": "AI-ME",
                "roots": [{"path": str(primary)}, {"path": str(secondary)}],
                "idempotencyKey": "snapshot-semantics",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={
                "projectId": project["id"],
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()
        client.patch(
            f"/api/projects/{project['id']}",
            json={"name": "changed", "roots": [{"path": str(replacement)}]},
        )
        unchanged = client.get(f"/api/sessions/{session['id']}").json()
        client.delete(f"/api/projects/{project['id']}")
        unbound = client.get(f"/api/sessions/{session['id']}").json()
        items = client.get(f"/api/sessions/{session['id']}/items")

    expected_roots = [str(primary.resolve()), str(secondary.resolve())]
    assert unchanged["projectId"] == project["id"]
    assert unchanged["workspaceRoots"] == expected_roots
    assert unbound["projectId"] is None
    assert unbound["workspaceRoots"] == expected_roots
    assert items.status_code == 200
    assert items.json() == []


def test_user_can_send_a_turn_and_reopen_the_conversation(tmp_path: Path) -> None:
    """用户消息与模型回答都应形成持久 Item。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_dir = tmp_path / "state"
    gateway = _GreetingModelGateway()

    with TestClient(
        create_app(build_container(state_dir=state_dir, model_gateway=gateway))
    ) as client:
        created = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        )
        session_id = created.json()["id"]

        started = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "你好", "clientRequestId": "turn-request-1"},
        )
        assert started.status_code == 202

        # Runtime 在后台运行；通过公开查询接口等待最终 Item，而不是读取数据库内部状态。
        items: list[dict[str, object]] = []
        for _ in range(100):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if [item["type"] for item in items] == ["user_message", "agent_message"]:
                break
            time.sleep(0.01)

    assert [(item["type"], item["content"]) for item in items] == [
        ("user_message", {"text": "你好"}),
        ("agent_message", {"text": "你好！"}),
    ]

    with TestClient(
        create_app(build_container(state_dir=state_dir, model_gateway=gateway))
    ) as reopened_client:
        reopened_items = reopened_client.get(f"/api/sessions/{session_id}/items")

    assert reopened_items.status_code == 200
    assert reopened_items.json() == items


def test_second_turn_receives_persisted_conversation_history(tmp_path: Path) -> None:
    """第二轮模型请求必须包含第一轮问答和本轮用户输入。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _HistoryModelGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "第一问", "clientRequestId": "history-1"},
        )
        for _ in range(100):
            if len(client.get(f"/api/sessions/{session_id}/items").json()) == 2:
                break
            time.sleep(0.01)
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "第二问", "clientRequestId": "history-2"},
        )
        for _ in range(100):
            if len(client.get(f"/api/sessions/{session_id}/items").json()) == 4:
                break
            time.sleep(0.01)

    assert [(message.role.value, message.content) for message in gateway.requests[1].messages] == [
        ("user", "第一问"),
        ("assistant", "第一答"),
        ("user", "第二问"),
    ]


def test_session_usage_separates_cumulative_tokens_from_current_context(tmp_path: Path) -> None:
    """累计输入输出按调用求和，上下文进度只读取最新模型步骤。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_UsageModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        for turn_number in (1, 2):
            client.post(
                f"/api/sessions/{session_id}/turns",
                json={
                    "input": f"第 {turn_number} 问",
                    "clientRequestId": f"usage-{turn_number}",
                },
            )
            for _ in range(100):
                if len(client.get(f"/api/sessions/{session_id}/items").json()) == turn_number * 2:
                    break
                time.sleep(0.01)

        usage = client.get(f"/api/sessions/{session_id}/usage")

    assert usage.status_code == 200
    assert usage.json() == {
        "inputTokens": 30_000,
        "outputTokens": 2_000,
        "totalTokens": 32_000,
        "currentContextTokens": 19_200,
        "contextWindow": 128_000,
        "measuredSteps": 2,
        "unreportedSteps": 0,
        "untrackedHistory": False,
        "windowNumber": 1,
        "contextEstimated": False,
    }


def test_session_usage_marks_steps_without_provider_usage_as_partial(tmp_path: Path) -> None:
    """提供方未报告时保留缺失步骤，并用本地估算展示上下文而非伪造实测用量。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_GreetingModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "你好", "clientRequestId": "usage-missing"},
        )
        for _ in range(100):
            if len(client.get(f"/api/sessions/{session_id}/items").json()) == 2:
                break
            time.sleep(0.01)

        usage = client.get(f"/api/sessions/{session_id}/usage")

    assert usage.status_code == 200
    payload = usage.json()
    # 系统提示与工具定义会影响估算值，契约要求有效估算而非固定的 token 数。
    assert isinstance(payload["currentContextTokens"], int)
    assert payload["currentContextTokens"] > 0
    assert payload == {
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
        "currentContextTokens": payload["currentContextTokens"],
        "contextWindow": 128_000,
        "measuredSteps": 0,
        "unreportedSteps": 1,
        "untrackedHistory": False,
        "windowNumber": 1,
        "contextEstimated": True,
    }


def test_session_list_returns_context_usage_for_every_session(tmp_path: Path) -> None:
    """侧栏一次列表请求应同时获得已测量圆环和未测量空心圆状态。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_UsageModelGateway(),
            )
        )
    ) as client:
        measured = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        unmeasured = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{measured}/turns",
            json={"input": "测量上下文", "clientRequestId": "list-usage"},
        )
        for _ in range(100):
            items = client.get(f"/api/sessions/{measured}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)
        listed = client.get("/api/sessions").json()

    by_id = {item["id"]: item for item in listed}
    assert by_id[measured]["contextUsage"] == {
        "currentContextTokens": 12_800,
        "contextWindow": 128_000,
        "percentage": 10,
        "partial": False,
    }
    assert by_id[unmeasured]["contextUsage"] == {
        "currentContextTokens": None,
        "contextWindow": None,
        "percentage": None,
        "partial": True,
    }


def test_session_rejects_a_second_active_turn(tmp_path: Path) -> None:
    """同一 Session 同时只能有一个活跃 Turn，冲突必须返回稳定的 409。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    container = build_container(
        state_dir=tmp_path / "state",
        model_gateway=_SlowModelGateway(),
    )

    with TestClient(create_app(container)) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        first = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "第一个任务", "clientRequestId": "request-one"},
        )
        second = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "第二个任务", "clientRequestId": "request-two"},
        )

        assert first.status_code == 202
        assert second.status_code == 409
        assert second.json()["detail"] == "Session 已有正在执行的 Turn"


def test_repeating_client_request_does_not_run_the_model_twice(tmp_path: Path) -> None:
    """网络重试同一个 clientRequestId 时必须复用 Turn，不能重复调用模型。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _GreetingModelGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        payload = {"input": "你好", "clientRequestId": "same-request"}
        first = client.post(f"/api/sessions/{session_id}/turns", json=payload)

        for _ in range(100):
            if len(client.get(f"/api/sessions/{session_id}/items").json()) == 2:
                break
            time.sleep(0.01)

        repeated = client.post(f"/api/sessions/{session_id}/turns", json=payload)
        items = client.get(f"/api/sessions/{session_id}/items").json()

    assert repeated.status_code == 202
    assert repeated.json()["id"] == first.json()["id"]
    assert gateway.call_count == 1
    assert [item["type"] for item in items] == ["user_message", "agent_message"]


def test_runtime_events_can_be_replayed_from_a_sequence_cursor(tmp_path: Path) -> None:
    """断线后可从 afterSequence 重放持久 RuntimeEvent。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_GreetingModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "你好", "clientRequestId": "event-request"},
        )
        for _ in range(100):
            if len(client.get(f"/api/sessions/{session_id}/items").json()) == 2:
                break
            time.sleep(0.01)

        response = client.get(f"/api/sessions/{session_id}/events?afterSequence=1")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    payloads = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [payload["type"] for payload in payloads] == [
        "skills_catalog",
        "context_status",
        "text_delta",
        "text_delta",
        "model_usage",
        "agent_message",
        "run_completed",
    ]
    assert [payload["sequence"] for payload in payloads] == [2, 3, 4, 5, 6, 7, 8]


def test_sessions_are_listed_by_recent_activity_with_a_first_turn_title(tmp_path: Path) -> None:
    """会话列表应可恢复，首轮输入会成为可辨认的默认标题。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_GreetingModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "你好", "clientRequestId": "title-request"},
        )
        for _ in range(100):
            sessions = client.get("/api/sessions")
            if sessions.status_code == 200 and sessions.json()[0]["activity"] == "idle":
                break
            time.sleep(0.01)

    assert sessions.status_code == 200
    assert sessions.json()[0]["id"] == session_id
    assert sessions.json()[0]["title"] == "你好"


def test_user_can_interrupt_an_active_turn(tmp_path: Path) -> None:
    """用户中断必须写入终态，并立即释放 Session 继续下一轮。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_SlowModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        turn = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "长任务", "clientRequestId": "interrupt-request"},
        ).json()

        interrupted = client.post(
            f"/api/sessions/{session_id}/turns/{turn['id']}/interrupt"
        )
        session = client.get(f"/api/sessions/{session_id}").json()
        items = client.get(f"/api/sessions/{session_id}/items").json()

    assert interrupted.status_code == 204
    assert session["activity"] == "idle"
    assert [item["type"] for item in items] == ["user_message", "error"]
    assert items[-1]["content"] == {"message": "执行已中断"}


def test_active_turn_can_be_recovered_after_switching_sessions(tmp_path: Path) -> None:
    """客户端重新打开运行中的 Session 时，可以恢复当前 Turn 标识并继续中断。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_SlowModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        started = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "长任务", "clientRequestId": "active-turn"},
        ).json()

        active = client.get(f"/api/sessions/{session_id}/turns/active")
        interrupted = client.post(
            f"/api/sessions/{session_id}/turns/{started['id']}/interrupt"
        )
        no_active = client.get(f"/api/sessions/{session_id}/turns/active")

    assert active.status_code == 200
    assert active.json()["id"] == started["id"]
    assert active.json()["status"] in {"queued", "in_progress"}
    assert interrupted.status_code == 204
    assert no_active.status_code == 200
    assert no_active.json() is None


def test_empty_model_response_becomes_a_visible_failure(tmp_path: Path) -> None:
    """空回答不能写成成功消息，否则下一轮历史将无法构造。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_EmptyModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "会被过滤的问题", "clientRequestId": "empty-response"},
        )
        for _ in range(100):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)

    assert [item["type"] for item in items] == ["user_message", "error"]
    assert items[-1]["content"] == {"message": "模型未返回可显示内容"}


def test_items_of_an_unknown_session_return_not_found(tmp_path: Path) -> None:
    """不存在的会话不能伪装成空会话。"""
    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        response = client.get(f"/api/sessions/{uuid4()}/items")

    assert response.status_code == 404


def test_idempotency_key_cannot_be_reused_for_different_input(tmp_path: Path) -> None:
    """同一幂等键绑定原请求，不能静默接受另一段输入。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _GreetingModelGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "你好", "clientRequestId": "fixed-key"},
        )
        conflict = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "不同输入", "clientRequestId": "fixed-key"},
        )

    assert conflict.status_code == 409
    assert conflict.json()["detail"] == "clientRequestId 已绑定另一段输入"


def test_client_can_reconcile_an_uncertain_turn_request(tmp_path: Path) -> None:
    """POST 响应丢失后，客户端应能按幂等键查询服务端是否已经接受请求。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=_SlowModelGateway(),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "openai/gpt-5",
                "permissionProfile": "workspace_write",
            },
        ).json()["id"]
        started = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "可能丢响应", "clientRequestId": "reconcile-key"},
        ).json()

        reconciled = client.get(
            f"/api/sessions/{session_id}/turns/by-client-request",
            params={"clientRequestId": "reconcile-key"},
        )
        missing = client.get(
            f"/api/sessions/{session_id}/turns/by-client-request",
            params={"clientRequestId": "unknown-key"},
        )

    assert reconciled.status_code == 200
    assert reconciled.json()["id"] == started["id"]
    assert missing.status_code == 200
    assert missing.json() is None
