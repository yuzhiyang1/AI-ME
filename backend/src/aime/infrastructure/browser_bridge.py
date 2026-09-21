"""单桌面连接的请求关联器；WebSocket 传输细节留在接口层。"""

import asyncio
import re
from collections.abc import Awaitable, Callable
from uuid import uuid4

from aime.application.ports.browser import BrowserOperation
from aime.domain.browser import BrowserConflict, BrowserError, BrowserUnavailable

SendMessage = Callable[[dict[str, object]], Awaitable[None]]


class DesktopBrowserBridge:
    """维护连接世代和挂起请求，断线、超时、取消均清理请求账本。"""

    def __init__(self, timeout: float = 30, cancel_timeout: float = 1) -> None:
        self._connection_id: str | None = None
        self._send: SendMessage | None = None
        self._disconnected = asyncio.Event()
        self._disconnected.set()
        self._pending: dict[str, asyncio.Future[dict[str, object]]] = {}
        self._timeout = timeout
        self._cancel_timeout = cancel_timeout
        self._send_lock = asyncio.Lock()

    @property
    def connection_id(self) -> str | None:
        return self._connection_id

    def attach(self, send: SendMessage) -> str:
        """同步占有唯一连接，第二个桌面不能踢掉正在使用的桌面。"""
        if self._connection_id is not None:
            raise BrowserConflict("已有桌面浏览器连接")
        self._connection_id = str(uuid4())
        self._send = send
        self._disconnected = asyncio.Event()
        return self._connection_id

    def detach(self, connection_id: str) -> None:
        """旧连接的迟到清理不能影响已重连的新桌面。"""
        if connection_id != self._connection_id:
            return
        self._connection_id = None
        self._send = None
        self._disconnected.set()
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BrowserUnavailable("桌面浏览器已断开"))
        self._pending.clear()

    async def wait_disconnected(self, connection_id: str) -> None:
        if connection_id == self._connection_id:
            await self._disconnected.wait()

    def receive(self, connection_id: str, message: object) -> None:
        """只完成匹配请求；迟到和重复回复忽略，格式错误使连接失效。"""
        if connection_id != self._connection_id:
            return
        if (
            not isinstance(message, dict) or not isinstance(message.get("id"), str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", message["id"]) is None
        ):
            raise BrowserError("桌面桥接响应格式无效")
        has_result, has_error = "result" in message, "error" in message
        if (
            has_result == has_error
            or (has_result and not isinstance(message["result"], dict))
            or (has_error and not isinstance(message["error"], str))
        ):
            raise BrowserError("桌面桥接响应格式无效")
        future = self._pending.get(message["id"])
        if future is None or future.done():
            return
        if has_error:
            # 远端错误可能包含页面内容或敏感配置，不原样回显。
            future.set_exception(BrowserError("桌面浏览器操作失败，请重新观察页面"))
        else:
            future.set_result(message["result"])

    async def request(
        self, session_id: str, operation: BrowserOperation, arguments: dict[str, object],
        *, connection_id: str,
    ) -> dict[str, object]:
        if connection_id != self._connection_id or self._send is None:
            raise BrowserUnavailable("桌面浏览器未连接")
        identity = str(uuid4())
        future: asyncio.Future[dict[str, object]] = asyncio.get_running_loop().create_future()
        self._pending[identity] = future
        sent = False
        try:
            async with asyncio.timeout(self._timeout):
                async with self._send_lock:
                    if connection_id != self._connection_id or self._send is None:
                        raise BrowserUnavailable("桌面浏览器已断开")
                    # 即使 send 中途取消也尝试撤销，不能假定桌面尚未收到字节。
                    sent = True
                    await self._send({
                        "id": identity, "sessionId": session_id,
                        "operation": operation, "arguments": arguments,
                    })
                return await future
        except TimeoutError:
            acknowledged = await self._cancel_request(
                identity, session_id, arguments, connection_id,
            ) if sent else True
            suffix = "；已撤销请求" if acknowledged else "；撤销未确认，已发送动作的结果不确定"
            raise BrowserUnavailable("桌面浏览器响应超时" + suffix) from None
        except asyncio.CancelledError:
            if sent:
                await self._cancel_request(identity, session_id, arguments, connection_id)
            raise
        except BrowserError:
            raise
        except Exception:
            self.detach(connection_id)
            raise BrowserUnavailable("桌面浏览器发送失败") from None
        finally:
            self._pending.pop(identity, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # 发送期间断线时也消费异常，避免产生未检索 Future 警告。
                future.exception()

    async def _cancel_request(
        self, request_id: str, session_id: str, arguments: dict[str, object], connection_id: str,
    ) -> bool:
        """撤销已送命令，有限等待 ACK；原 runId 隔离迟到取消与新任务。"""
        if self._connection_id != connection_id or self._send is None:
            return False
        cancel_id = str(uuid4())
        future: asyncio.Future[dict[str, object]] = asyncio.get_running_loop().create_future()
        self._pending[cancel_id] = future
        try:
            async with asyncio.timeout(self._cancel_timeout):
                async with self._send_lock:
                    if self._connection_id != connection_id or self._send is None:
                        return False
                    await self._send({
                        "id": cancel_id, "sessionId": session_id, "operation": "cancel",
                        "arguments": {"requestId": request_id, "runId": arguments.get("runId")},
                    })
                await future
                return True
        except (Exception, asyncio.CancelledError):
            return False
        finally:
            self._pending.pop(cancel_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()
