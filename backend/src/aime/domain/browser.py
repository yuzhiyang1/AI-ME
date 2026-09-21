"""浏览器任务的领域状态；不依赖 Web、数据库或模型 SDK。"""

from dataclasses import dataclass, field
from enum import StrEnum
from math import isfinite
from typing import Literal

ActionKind = Literal["click", "fill", "select", "scroll", "wait"]


class BrowserError(Exception):
    """可安全展示给工作台的浏览器错误，不包含供应商响应或密钥。"""


class BrowserUnavailable(BrowserError):
    """桌面桥接或模型未就绪。"""


class BrowserConflict(BrowserError):
    """当前任务状态不允许请求的操作。"""


class BrowserRunNotFound(BrowserError):
    """指定会话下没有该浏览器任务。"""


@dataclass(frozen=True, slots=True)
class BrowserConfiguration:
    """独立设置记录；记录存在即覆盖环境配置，空凭据表示显式禁用。"""

    model: str
    credential_id: str | None


class BrowserStatus(StrEnum):
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    STOPPED = "stopped"
    FAILED = "failed"
    NEEDS_VERIFICATION = "needs_verification"
    BLOCKED = "blocked"


@dataclass(frozen=True, slots=True)
class BrowserAction:
    """只允许操作桌面端观察结果中已有的动作身份。"""

    id: str
    kind: ActionKind
    label: str
    node: int | None = None
    value: str | None = None
    role: str | None = None


@dataclass(frozen=True, slots=True)
class BrowserSnapshot:
    """一次不可变观察；快照的新鲜度由 Electron 在执行时最终确认。"""

    id: str
    url: str
    title: str
    text: str
    actions: tuple[BrowserAction, ...]


def parse_snapshot(raw: dict[str, object]) -> BrowserSnapshot:
    """拒绝缺字段、重复动作和非预期类型，不能让坏观察进入模型。"""
    from typing import cast

    for key in ("snapshotId", "url", "title", "text"):
        if not isinstance(raw.get(key), str):
            raise BrowserError("浏览器观察结果格式无效")
    if not raw["snapshotId"]:
        raise BrowserError("浏览器快照身份不能为空")
    items = raw.get("actions")
    if not isinstance(items, list) or len(items) > 2000:
        raise BrowserError("浏览器动作列表无效或过大")
    actions: list[BrowserAction] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise BrowserError("浏览器动作格式无效")
        identity, kind, label = item.get("id"), item.get("kind"), item.get("label")
        if (
            not isinstance(identity, str) or not identity or identity in seen
            or kind not in ("click", "fill", "select", "scroll", "wait")
            or not isinstance(label, str)
        ):
            raise BrowserError("浏览器动作身份或类型无效")
        node, value, role = item.get("node"), item.get("value"), item.get("role")
        if (
            (node is not None and type(node) is not int)
            or (value is not None and not isinstance(value, str))
            or (role is not None and not isinstance(role, str))
        ):
            raise BrowserError("浏览器动作属性无效")
        seen.add(identity)
        actions.append(BrowserAction(identity, cast(ActionKind, kind), label, node, value, role))
    return BrowserSnapshot(
        cast(str, raw["snapshotId"]), cast(str, raw["url"]),
        cast(str, raw["title"]), cast(str, raw["text"]), tuple(actions),
    )


@dataclass(frozen=True, slots=True)
class BrowserDecision:
    """模型选出的操作及两个独立置信度；结束判断也须满足阈值。"""

    operation: str
    action_id: str | None
    confidence: float
    target_confidence: float | None = None

    def confident(self, threshold: float = 0.6) -> bool:
        values = [self.confidence]
        if self.action_id is not None:
            if self.target_confidence is None:
                return False
            values.append(self.target_confidence)
        return all(isfinite(value) and threshold <= value <= 1 for value in values)


@dataclass(slots=True)
class BrowserRun:
    """进程内运行投影；DONE 只能要求人工核验，不宣称业务成功。"""

    id: str
    session_id: str
    goal: str
    status: BrowserStatus = BrowserStatus.RUNNING
    steps: list[dict[str, object]] = field(default_factory=list)
    pending_action: dict[str, object] | None = None
    error: str | None = None

    @property
    def active(self) -> bool:
        return self.status in (BrowserStatus.RUNNING, BrowserStatus.AWAITING_APPROVAL)

    def to_dict(self) -> dict[str, object]:
        """持久化与 HTTP 共用的稳定投影，不含模型请求或凭据。"""
        result: dict[str, object] = {
            "id": self.id, "sessionId": self.session_id, "status": self.status.value,
            "goal": self.goal, "steps": self.steps,
        }
        if self.pending_action is not None:
            result["pendingAction"] = self.pending_action
        if self.error is not None:
            result["error"] = self.error
        return result
