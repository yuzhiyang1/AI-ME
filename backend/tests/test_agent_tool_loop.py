"""通过公开会话接口验证 Agent Loop 与本地工具执行。"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from aime.application.ports.agent_runtime import AgentRunRequest
from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmAssistantToolCallMessage,
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmStreamStarted,
    LlmTextDelta,
    LlmToolCallDelta,
    LlmToolDefinition,
    LlmToolResultMessage,
    MessageRole,
    ModelDescriptor,
)
from aime.application.ports.tool_execution import (
    ToolDescriptor,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolExecutionSemantics,
    ToolRiskLevel,
)
from aime.composition import build_container
from aime.domain.sessions.value_objects import PermissionProfile
from aime.infrastructure.runtime.approval_broker import InMemoryApprovalBroker
from aime.infrastructure.runtime.model_agent_runtime import ModelAgentRuntime
from aime.main import create_app


class _ReadFileToolCallingGateway:
    """先请求读取文件，再根据工具结果给出最终回答。"""

    def __init__(self) -> None:
        self.requests: list[LlmCompletionRequest] = []

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.requests.append(request)
        yield LlmStreamStarted()
        if len(self.requests) == 1:
            assert {tool.name for tool in request.tools} >= {"list_files", "read_file"}
            yield LlmToolCallDelta(0, "call-read", "read_file", '{"path":"note')
            yield LlmToolCallDelta(0, None, None, '.txt"}')
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
            return

        assistant_step = request.messages[-2]
        tool_result = request.messages[-1]
        assert isinstance(assistant_step, LlmAssistantToolCallMessage)
        assert assistant_step.tool_calls[0].call_id == "call-read"
        assert isinstance(tool_result, LlmToolResultMessage)
        assert tool_result.call_id == "call-read"
        assert tool_result.is_error is False
        assert json.loads(tool_result.content)["content"] == "来自工作区的内容"
        yield LlmTextDelta("我已经读取 note.txt：来自工作区的内容")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _WorkspacePromptGateway:
    """记录系统提示，用于验证主目录和附加目录都传入模型。"""

    def __init__(self) -> None:
        self.requests: list[LlmCompletionRequest] = []

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.requests.append(request)
        yield LlmStreamStarted()
        yield LlmTextDelta("目录已确认")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _ParallelProbeTool:
    """只有两个调用同时进入时才会释放，用于证明真实并行。"""

    descriptor = ToolDescriptor(
        definition=LlmToolDefinition(
            "parallel_probe",
            "并行探针",
            {
                "type": "object",
                "properties": {"id": {"type": "integer"}},
                "required": ["id"],
            },
        ),
        execution_semantics=ToolExecutionSemantics.PARALLEL,
        risk_level=ToolRiskLevel.READ,
    )

    def __init__(self) -> None:
        self.active = 0
        self.maximum_active = 0
        self.started = 0
        self.both_started = asyncio.Event()

    async def execute(
        self,
        arguments: dict[str, object],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        self.started += 1
        self.active += 1
        self.maximum_active = max(self.maximum_active, self.active)
        if self.started == 2:
            self.both_started.set()
        try:
            await asyncio.wait_for(self.both_started.wait(), timeout=1)
            return ToolExecutionResult({"id": arguments["id"]})
        finally:
            self.active -= 1


class _SingleToolRegistry:
    """仅向 Runtime 暴露并行探针。"""

    def __init__(self, tool: _ParallelProbeTool) -> None:
        self.tool = tool

    def descriptors(self, permission: PermissionProfile) -> tuple[ToolDescriptor, ...]:
        return (self.tool.descriptor,)

    def get(self, name: str) -> _ParallelProbeTool | None:
        return self.tool if name == self.tool.descriptor.definition.name else None


class _ParallelToolGateway:
    """在同一步按固定顺序请求两个可并行工具。"""

    def __init__(self) -> None:
        self.calls = 0

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.calls += 1
        yield LlmStreamStarted()
        if self.calls == 1:
            yield LlmToolCallDelta(0, "parallel-1", "parallel_probe", '{"id":1}')
            yield LlmToolCallDelta(1, "parallel-2", "parallel_probe", '{"id":2}')
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
            return
        results = request.messages[-2:]
        assert all(isinstance(result, LlmToolResultMessage) for result in results)
        assert [json.loads(result.content)["id"] for result in results] == [1, 2]
        yield LlmTextDelta("两个读取任务都完成了")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _MixedExclusiveGateway:
    """故意把读取和独占写入放在同一步，验证整步拒绝。"""

    def __init__(self) -> None:
        self.calls = 0

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.calls += 1
        yield LlmStreamStarted()
        if self.calls == 1:
            yield LlmToolCallDelta(0, "mixed-read", "read_file", '{"path":"note.txt"}')
            yield LlmToolCallDelta(
                1,
                "mixed-write",
                "write_file",
                '{"path":"created.txt","content":"bad"}',
            )
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
            return
        results = request.messages[-2:]
        assert all(isinstance(result, LlmToolResultMessage) for result in results)
        assert all(
            json.loads(result.content)["error"]["code"] == "exclusive_step_mixed"
            for result in results
        )
        yield LlmTextDelta("我会把写入改为单独一步")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _RepeatedFailureGateway:
    """持续重复同一无效调用，用于验证 Loop Gate。"""

    def __init__(self) -> None:
        self.calls = 0

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "tool-model", "Tool Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.calls += 1
        yield LlmStreamStarted()
        yield LlmToolCallDelta(
            0,
            f"bad-{self.calls}",
            "missing_tool",
            '{"same":true}',
        )
        yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)


class _PausedTextGateway:
    """首段文本后暂停，暴露 Runtime 是否真实逐段转发。"""

    def __init__(self, release: asyncio.Event) -> None:
        self.release = release

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "stream-model", "Stream Model", 32_000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        yield LlmStreamStarted()
        yield LlmTextDelta("第一段")
        await self.release.wait()
        yield LlmTextDelta("第二段")
        yield LlmStreamCompleted(LlmFinishReason.STOP)


class _NoExistingToolExecutions:
    """无工具调用场景只需要声明没有恢复中的执行账本。"""

    async def list_run_invocations(self, run_id: object) -> list[object]:
        return []


def test_runtime_forwards_text_before_provider_stream_completes() -> None:
    """首段模型文本不得等待整个 Provider 流结束后才交给用户。"""

    async def scenario() -> None:
        release = asyncio.Event()
        runtime = ModelAgentRuntime(
            _PausedTextGateway(release),
            _NoExistingToolExecutions(),  # type: ignore[arg-type]
            InMemoryApprovalBroker(),
        )
        stream = runtime.run(
            AgentRunRequest(
                instruction="测试真实流式",
                session_id="00000000-0000-4000-8000-000000000001",
                turn_id="00000000-0000-4000-8000-000000000002",
                run_id="00000000-0000-4000-8000-000000000003",
                model_ref="qa/stream-model",
                messages=(ConversationMessage(MessageRole.USER, "你好"),),
            )
        )

        try:
            first_event = await asyncio.wait_for(anext(stream), timeout=0.1)
        finally:
            release.set()
        assert first_event.type == "text_delta"
        assert first_event.content == "第一段"
        remaining = [event async for event in stream]
        assert [(event.type, event.content) for event in remaining] == [
            ("text_delta", "第二段"),
            ("model_usage", ""),
        ]

    asyncio.run(scenario())


def test_agent_loop_executes_a_read_tool_then_returns_the_final_answer(tmp_path: Path) -> None:
    """模型的工具请求应被执行，结果回填模型后再形成最终 Agent 消息。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "note.txt").write_text("来自工作区的内容", encoding="utf-8")
    gateway = _ReadFileToolCallingGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "read_only",
            },
        ).json()["id"]
        started = client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "读取 note.txt", "clientRequestId": "tool-loop-read"},
        )
        assert started.status_code == 202

        items: list[dict[str, object]] = []
        for _ in range(200):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)
        events_response = client.get(f"/api/sessions/{session_id}/events")
        invocations = client.get(f"/api/sessions/{session_id}/tool-invocations").json()

    assert len(gateway.requests) == 2
    assert len(invocations) == 1
    assert invocations[0]["status"] == "completed"
    assert invocations[0]["toolName"] == "read_file"
    assert invocations[0]["result"]["content"] == "来自工作区的内容"
    assert [(item["type"], item["content"]) for item in items] == [
        ("user_message", {"text": "读取 note.txt"}),
        ("agent_message", {"text": "我已经读取 note.txt：来自工作区的内容"}),
    ]
    event_types = [
        json.loads(line.removeprefix("data: "))["type"]
        for line in events_response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert event_types == [
        "user_message",
        "model_usage",
        "tool_prepared",
        "tool_started",
        "tool_completed",
        "text_delta",
        "model_usage",
        "agent_message",
        "run_completed",
    ]


def test_project_session_declares_primary_and_additional_roots_to_model(tmp_path: Path) -> None:
    """项目会话每轮都应把 Session roots 快照告诉模型，而不是运行时查询 Project。"""
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    primary.mkdir()
    secondary.mkdir()
    gateway = _WorkspacePromptGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        project = client.post(
            "/api/projects",
            json={
                "name": "AI-ME",
                "roots": [{"path": str(primary)}, {"path": str(secondary)}],
                "idempotencyKey": "prompt-roots",
            },
        ).json()
        session_id = client.post(
            "/api/sessions",
            json={
                "projectId": project["id"],
                "defaultModel": "qa/tool-model",
                "permissionProfile": "read_only",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "确认目录", "clientRequestId": "prompt-roots-turn"},
        )
        for _ in range(200):
            if gateway.requests:
                break
            time.sleep(0.01)

    assert gateway.requests
    system = gateway.requests[0].system or ""
    assert f"当前会话主目录：{primary.resolve()}" in system
    assert f"- {secondary.resolve()}" in system
    assert "访问附加目录时使用绝对路径" in system


def test_parallel_tools_overlap_but_results_keep_model_call_order(tmp_path: Path) -> None:
    """可并行工具应真实重叠执行，回填顺序仍保持确定。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    tool = _ParallelProbeTool()
    gateway = _ParallelToolGateway()

    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_gateway=gateway,
                tool_registry=_SingleToolRegistry(tool),
            )
        )
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "read_only",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "并行执行", "clientRequestId": "parallel-tools"},
        )
        for _ in range(200):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)

    assert tool.maximum_active == 2
    assert items[-1]["content"] == {"text": "两个读取任务都完成了"}


def test_exclusive_tool_mixed_with_other_calls_is_rejected_before_dispatch(
    tmp_path: Path,
) -> None:
    """独占工具混用时不排队偷跑，而是让模型下一步重新规划。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "note.txt").write_text("safe", encoding="utf-8")
    gateway = _MixedExclusiveGateway()

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
            json={"input": "混合调用", "clientRequestId": "exclusive-mixed"},
        )
        for _ in range(200):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)

    assert not (workspace / "created.txt").exists()
    assert items[-1]["content"] == {"text": "我会把写入改为单独一步"}


def test_identical_failed_call_is_stopped_after_three_attempts(tmp_path: Path) -> None:
    """同工具同参数连续失败三次时，Runtime 必须收敛为可见错误。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    gateway = _RepeatedFailureGateway()

    with TestClient(
        create_app(build_container(state_dir=tmp_path / "state", model_gateway=gateway))
    ) as client:
        session_id = client.post(
            "/api/sessions",
            json={
                "workspacePath": str(workspace),
                "defaultModel": "qa/tool-model",
                "permissionProfile": "read_only",
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/turns",
            json={"input": "重复失败", "clientRequestId": "loop-gate"},
        )
        for _ in range(200):
            items = client.get(f"/api/sessions/{session_id}/items").json()
            if len(items) == 2:
                break
            time.sleep(0.01)

    assert gateway.calls == 3
    assert items[-1]["type"] == "error"
    assert "连续失败 3 次" in items[-1]["content"]["message"]
