"""真实 Electron/HTTP/WS 验收入口；仅替换两个模型和系统凭据存储。

从 backend 启动：uv run uvicorn tests.browser_acceptance_app:app --port 8765。
必须设置 AI_ME_ACCEPTANCE_DIR 和 64 位 hex AIME_BROWSER_BRIDGE_TOKEN。
夹具页面含 label=Search 的输入和按钮，提交后显示 Found: Jev browser test。
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from aime.application.ports.model_gateway import (
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmTextDelta,
    ModelDescriptor,
)
from aime.composition import build_container
from aime.domain.browser import BrowserDecision, BrowserSnapshot
from aime.main import create_app


class AcceptanceCredentialStore:
    """验收凭据仅驻留内存，绝不触碰操作系统 keyring。"""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get(self, configuration_id: str) -> str | None:
        return self.values.get(configuration_id)

    async def set(self, configuration_id: str, api_key: str) -> None:
        self.values[configuration_id] = api_key

    async def delete(self, configuration_id: str) -> None:
        self.values.pop(configuration_id, None)


class AcceptanceBrowserPlanner:
    """只依据真实观察决定步骤，不能仅凭调用次数宣称完成。"""

    def __init__(self) -> None:
        self.model = "jev-acceptance"
        self.configured = False

    def configure(self, model: str, api_key: str) -> None:
        self.model, self.configured = model, bool(api_key)

    async def choose(
        self, snapshot: BrowserSnapshot, goal: str, history: list[dict[str, object]],
    ) -> BrowserDecision:
        if "Found: Jev browser test" in snapshot.text:
            return BrowserDecision("DONE", None, 1)
        inputs = [a for a in snapshot.actions if a.kind == "fill" and "Search" in a.label]
        if inputs and inputs[0].value != "Jev browser test":
            return BrowserDecision("TYPE_TEXT", inputs[0].id, 1, 1)
        buttons = [a for a in snapshot.actions if a.kind == "click" and "Search" in a.label]
        if buttons:
            return BrowserDecision("CLICK", buttons[0].id, 1, 1)
        return BrowserDecision("BLOCKED", None, 1)


class AcceptanceTextGateway:
    """复用真实文字网关路径，只替换付费模型的响应。"""

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "browser-text", "浏览器验收文字模型", 128000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        yield LlmTextDelta('{"text":"Jev browser test"}')
        yield LlmStreamCompleted(LlmFinishReason.STOP)


state = Path(os.environ["AI_ME_ACCEPTANCE_DIR"]).resolve()
container = build_container(
    state_dir=state / "state",
    model_gateway=AcceptanceTextGateway(),
    model_credential_store=AcceptanceCredentialStore(),
    browser_planner=AcceptanceBrowserPlanner(),
)
app = create_app(container)
original_lifespan = app.router.lifespan_context


@asynccontextmanager
async def acceptance_lifespan(application: FastAPI) -> AsyncIterator[None]:
    """启动后写入隔离的假配置；真实设置保存和数据库迁移仍被执行。"""
    async with original_lifespan(application):
        await container.browser_service.save_config("jev-acceptance", "acceptance-fake-key", False)
        yield


app.router.lifespan_context = acceptance_lifespan
