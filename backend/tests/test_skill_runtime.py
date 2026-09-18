"""通过真实 Runtime 和 SQLite 检查模型实际收到的 Skill 消息。"""

import json
from collections.abc import AsyncIterator
from dataclasses import replace

import pytest
from test_context_management import context_env  # noqa: F401
from test_skills import make_skill

from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmTextDelta,
    LlmToolCallDelta,
    LlmToolResultMessage,
    ModelDescriptor,
)
from aime.application.skill_service import SkillService
from aime.infrastructure.llm.token_counter import ConservativeTokenCounter
from aime.infrastructure.persistence.sqlite_skill_store import SqliteSkillStore
from aime.infrastructure.persistence.sqlite_tool_execution_store import SqliteToolExecutionStore
from aime.infrastructure.runtime.approval_broker import InMemoryApprovalBroker
from aime.infrastructure.runtime.model_agent_runtime import ModelAgentRuntime
from aime.infrastructure.skills import LocalSkillResources


class SkillGateway:
    """记录完整模型请求，用固定响应验证工具协议，不调用付费模型。"""

    def __init__(self, ref: str, explicit: bool):
        self.ref = ref
        self.explicit = explicit
        self.requests: list[LlmCompletionRequest] = []

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "context", "测试模型", 128000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        self.requests.append(request)
        number = len(self.requests)
        if number == 1 and not self.explicit:
            yield LlmToolCallDelta(0, "read-skill", "skill_read", json.dumps({"ref": self.ref}))
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
        elif number == (1 if self.explicit else 2):
            yield LlmToolCallDelta(0, "rollover", "new_context", "{}")
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
        else:
            yield LlmTextDelta("检查完成：除数为零需要处理。")
            yield LlmStreamCompleted(LlmFinishReason.STOP)


@pytest.mark.parametrize("explicit", [True, False])
@pytest.mark.parametrize("catalog_size", [1, 1000])
async def test_runtime_load_and_rollover_preserve_skill_version(
    context_env, tmp_path, explicit, catalog_size, monkeypatch,  # noqa: F811
):
    database, store, artifacts, request = context_env
    make_skill(tmp_path)
    service = SkillService(LocalSkillResources(()), SqliteSkillStore(database.session_factory))
    skills, _ = await service.inventory((str(tmp_path),))
    if catalog_size > 1:
        # 用真实文件作为可读取目标，其余生成目录项检查完整请求的规模边界。
        async def large_inventory(roots):
            return [skills[0]] + [
                replace(skills[0], ref=f"extra:{index}", name=f"extra-{index}")
                for index in range(catalog_size - 1)
            ], []
        monkeypatch.setattr(service, "inventory", large_inventory)
    gateway = SkillGateway(skills[0].ref, explicit)
    if explicit:
        request = replace(request, instruction=f"/skill:{skills[0].ref} 检查代码")
    runtime = ModelAgentRuntime(
        gateway,
        SqliteToolExecutionStore(database.session_factory),
        InMemoryApprovalBroker(),
        context_store=store,
        artifact_store=artifacts,
        token_counter=ConservativeTokenCounter(),
        skill_service=service,
    )
    events = [event async for event in runtime.run(request)]
    assert not [event for event in events if event.type == "failed"]
    assert len(gateway.requests) == (2 if explicit else 3)
    initial = gateway.requests[0]
    assert "检查除数为零" not in initial.system
    if explicit:
        assert any("检查除数为零" in str(message) for message in initial.messages)
    else:
        assert any(
            isinstance(message, LlmToolResultMessage) and "检查除数为零" in message.content
            for message in gateway.requests[1].messages
        )
    assert (await store.window(request.session_id)).number >= 2
    assert skills[0].version in str(gateway.requests[-1].messages)
    assert "skill_read" in [tool.name for tool in gateway.requests[-1].tools]
    counter = ConservativeTokenCounter()
    assert all(counter.count(item) < 128000 for item in gateway.requests)
