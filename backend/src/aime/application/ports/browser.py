"""浏览器桥接、离散决策和文字生成的应用端口。"""

from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

from aime.domain.browser import (
    BrowserAction,
    BrowserConfiguration,
    BrowserDecision,
    BrowserRun,
    BrowserSnapshot,
)

BrowserOperation = Literal["navigate", "observe", "act", "close", "cancel"]


class BrowserBridge(Protocol):
    """运行绑定连接身份，重连不能接手旧任务或旧请求。"""

    @property
    def connection_id(self) -> str | None: ...

    async def wait_disconnected(self, connection_id: str) -> None: ...

    async def request(
        self, session_id: str, operation: BrowserOperation, arguments: dict[str, object],
        *, connection_id: str,
    ) -> dict[str, object]: ...


class BrowserPlanner(Protocol):
    """从当前快照候选中选择动作，不产生任意脚本或定位器。"""

    @property
    def configured(self) -> bool: ...

    @property
    def model(self) -> str: ...

    def configure(self, model: str, api_key: str) -> None: ...

    async def choose(
        self, snapshot: BrowserSnapshot, goal: str, history: list[dict[str, object]],
    ) -> BrowserDecision: ...


class BrowserBridgeServer(BrowserBridge, Protocol):
    """接口层向桥接器交付连接与消息，不依赖具体基础设施类。"""

    def attach(self, send: Callable[[dict[str, object]], Awaitable[None]]) -> str: ...

    def detach(self, connection_id: str) -> None: ...

    def receive(self, connection_id: str, message: object) -> None: ...


class BrowserTextGenerator(Protocol):
    """只为已选择的 fill 动作生成待确认文字。"""

    @property
    def configured(self) -> bool: ...

    def validate_model(self, model_ref: str | None) -> None: ...

    async def generate(
        self, snapshot: BrowserSnapshot, action: BrowserAction, goal: str,
        model_ref: str | None,
    ) -> str: ...


class BrowserConfigurationRepository(Protocol):
    """只保存模型名和凭据引用，API Key 不得进入 SQLite。"""

    async def get(self) -> BrowserConfiguration | None: ...

    async def save(self, configuration: BrowserConfiguration) -> None: ...


class BrowserRunRepository(Protocol):
    """持久化运行及步骤，重启只恢复展示事实，不重放网页操作。"""

    async def save(self, run: BrowserRun) -> None: ...

    async def current(self, session_id: str) -> BrowserRun | None: ...

    async def recover(self) -> None: ...
