"""仅供 Electron 主进程代理访问的浏览器 HTTP 与 WebSocket 接口。"""

import json
import re
import secrets
from collections.abc import Callable, Coroutine
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from starlette.datastructures import Headers
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from aime.application.browser_service import BrowserService
from aime.application.ports.browser import BrowserBridgeServer
from aime.application.sessions.services import SessionNotFound
from aime.domain.browser import (
    BrowserConflict,
    BrowserError,
    BrowserRunNotFound,
    BrowserUnavailable,
)


class BrowserAuthenticationMiddleware:
    """浏览器命名空间默认拒绝：缺少启动令牌禁用，任何有值 Origin 均拒绝。"""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self._token = token if re.fullmatch(r"[0-9a-fA-F]{64}", token) else ""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] not in ("http", "websocket") or not (
            path == "/api/browser" or path.startswith("/api/browser/")
        ):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        error: tuple[int, str] | None = None
        if not self._token:
            error = (503, "浏览器桥接未启用")
        elif any(value for value in headers.getlist("origin")):
            error = (403, "浏览器接口不接受 Origin")
        else:
            authorizations = headers.getlist("authorization")
            bearer = (
                authorizations[0][7:] if len(authorizations) == 1
                and authorizations[0].lower().startswith("bearer ") else ""
            )
            valid = secrets.compare_digest(bearer.encode(), self._token.encode())
            protocols = scope.get("subprotocols", [])
            if scope["type"] == "websocket" and "aime-browser" in protocols:
                tokens = [p[6:] for p in protocols if p.startswith("token.")]
                if len(tokens) == 1:
                    valid = valid or secrets.compare_digest(
                        tokens[0].encode(), self._token.encode(),
                    )
            if not valid:
                error = (401, "浏览器接口鉴权失败")
        if error:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await JSONResponse({"detail": error[1]}, status_code=error[0])(scope, receive, send)
            return
        await self.app(scope, receive, send)


class _BrowserRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                # Pydantic 默认错误包含 input；配置请求不得回显任何 API Key。
                raise HTTPException(422, "浏览器请求格式无效") from None
            except SessionNotFound:
                raise HTTPException(404, "会话不存在") from None
            except BrowserRunNotFound as exc:
                raise HTTPException(404, str(exc)) from None
            except BrowserConflict as exc:
                raise HTTPException(409, str(exc)) from None
            except BrowserUnavailable as exc:
                raise HTTPException(503, str(exc)) from None
            except BrowserError as exc:
                raise HTTPException(422, str(exc)) from None

        return handle


class StartBrowserRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    goal: str = Field(min_length=1, max_length=8000, description="用户的浏览器任务目标")
    maxSteps: int = Field(default=20, ge=1, le=100, description="最大决策步数")
    textModelRef: str | None = Field(default=None, max_length=300, description="已有文字模型引用")
    confirmEachAction: bool = Field(default=True, description="执行点击、填写、选择前逐次确认")


class ApproveBrowserActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    approve: bool = Field(description="用户是否同意当前待执行动作")
    approvalId: str = Field(min_length=1, max_length=36, description="本次待确认动作的唯一审批身份")


class SaveBrowserConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    apiKey: SecretStr | None = Field(default=None, description="新密钥；省略时保留原凭据")
    model: str = Field(min_length=1, max_length=200, description="TypeSafe 模型名")
    clearApiKey: bool = Field(default=False, description="显式清除凭据并禁用环境回退")


def browser_router(service: BrowserService, bridge: BrowserBridgeServer) -> APIRouter:
    router = APIRouter(prefix="/api/browser", route_class=_BrowserRoute)

    @router.get("/config")
    async def config() -> dict[str, object]:
        return service.config()

    @router.post("/config")
    async def save_config(body: SaveBrowserConfigurationRequest) -> dict[str, object]:
        return await service.save_config(
            body.model, body.apiKey.get_secret_value() if body.apiKey is not None else None,
            body.clearApiKey,
        )

    @router.post("/sessions/{session_id}/runs", status_code=201)
    async def start(session_id: UUID, body: StartBrowserRunRequest) -> dict[str, object]:
        run = await service.start(
            session_id, body.goal, body.maxSteps, body.textModelRef, body.confirmEachAction,
        )
        return run.to_dict()

    @router.get("/sessions/{session_id}/runs/current")
    async def current(session_id: UUID) -> dict[str, object] | None:
        run = await service.current(session_id)
        return run.to_dict() if run else None

    @router.post("/sessions/{session_id}/runs/{run_id}/stop")
    async def stop(session_id: UUID, run_id: UUID) -> dict[str, object]:
        return (await service.stop(session_id, run_id)).to_dict()

    @router.post("/sessions/{session_id}/runs/{run_id}/approve")
    async def approve(
        session_id: UUID, run_id: UUID, body: ApproveBrowserActionRequest,
    ) -> dict[str, object]:
        return service.approve(session_id, run_id, body.approve, body.approvalId).to_dict()

    @router.websocket("/bridge")
    async def websocket_bridge(websocket: WebSocket) -> None:
        # 只回选功能协议，绝不能把 token 子协议回显到握手响应。
        protocol = "aime-browser" if "aime-browser" in websocket.scope["subprotocols"] else None
        await websocket.accept(subprotocol=protocol)
        try:
            connection_id = bridge.attach(websocket.send_json)
        except BrowserConflict:
            await websocket.close(code=1008, reason="已有桌面连接")
            return
        try:
            while True:
                message = await websocket.receive_text()
                if len(message) > 2_000_000:
                    raise BrowserError("桌面消息过大")
                bridge.receive(connection_id, json.loads(message))
        except WebSocketDisconnect:
            pass
        except (BrowserError, ValueError, TypeError, KeyError):
            await websocket.close(code=1008, reason="桌面桥接响应格式无效")
        finally:
            bridge.detach(connection_id)

    return router
