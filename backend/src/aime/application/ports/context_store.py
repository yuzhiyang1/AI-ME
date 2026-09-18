"""上下文存储端口：不暴露数据库、文件路径或模型 SDK。"""

from dataclasses import dataclass, field
from typing import Protocol

from aime.application.ports.model_gateway import (
    LlmAssistantToolCallMessage,
    LlmCompletionRequest,
    LlmInputMessage,
)


@dataclass(frozen=True, slots=True)
class ContextWindow:
    """基线及其覆盖边界；历史序号只在所属 Session 内用于比较。"""

    id: str
    number: int
    through_sequence: int  # 基线已替代的历史上界，重建时仅拼接此边界之后的条目。
    baseline: tuple[LlmInputMessage, ...] = ()


@dataclass(frozen=True, slots=True)
class ContextProgress:
    """Run 持久预算与安全步骤，不因重启或换窗重置。"""

    completed_step: int = 0  # 已完整提交历史的逻辑步骤，不等同于模型请求次数。
    request_count: int = 0  # 包含维护与溢出重试，换窗不清零。
    overflow_step: int | None = None  # 最近领取溢出重试机会的步骤；None 表示尚未领取。
    failure_signature: str | None = None
    failure_count: int = 0
    response_text: str = ""  # 已完成步骤的正文，供进程重启后恢复展示与最终回答。
    finished: bool = False


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """模型维护的任务数据；不具有指令或权限效力。"""

    version: int = 0
    covered_sequence: int = 0  # 模型声明已覆盖的历史边界，不是笔记真实性证明。
    content: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PendingContextStep:
    """T1 开始前保存完整模型批次，包括当时允许的工具，供崩溃后补齐执行。"""

    step: int
    message: LlmAssistantToolCallMessage
    allowed_tools: tuple[str, ...]


class ContextStore(Protocol):
    """持久化会话窗口与 Run 进度；调用方应在完整工具批次收敛后提交步骤。"""

    async def save_pending_step(self, run_id: str, pending: PendingContextStep) -> None: ...

    async def pending_step(self, run_id: str) -> PendingContextStep | None: ...
    async def initialize(
        self,
        session_id: str,
        turn_id: str,
        run_id: str,
        messages: tuple[LlmInputMessage, ...],
        instruction: str,
    ) -> ContextWindow: ...

    async def window(self, session_id: str) -> ContextWindow: ...

    async def messages(self, session_id: str) -> list[LlmInputMessage]: ...

    async def progress(self, run_id: str) -> ContextProgress: ...

    async def begin_request(self, run_id: str, maximum: int) -> int: ...

    async def record_step(
        self,
        session_id: str,
        run_id: str,
        step: int,
        messages: list[LlmInputMessage],
        failure_signature: str | None,
        failure_count: int,
        *,
        final: bool = False,
    ) -> None: ...

    async def checkpoint(self, session_id: str) -> Checkpoint: ...

    async def write_checkpoint(
        self,
        session_id: str,
        run_id: str,
        operation_id: str,
        expected_version: int,
        covered_sequence: int,
        content: dict[str, object],
    ) -> Checkpoint: ...

    async def latest_sequence(self, session_id: str) -> int: ...

    async def rollover(
        self,
        session_id: str,
        run_id: str,
        rollover_id: str,
        expected_window: str,
        through_sequence: int,
        baseline: list[LlmInputMessage],
        reason: str,
    ) -> ContextWindow: ...

    async def claim_overflow(self, run_id: str, step: int) -> bool: ...

    async def claim_maintenance(self, run_id: str, window_id: str) -> bool: ...

    async def history(
        self,
        session_id: str,
        *,
        after: int = 0,
        query: str = "",
        window_id: str = "",
        role: str = "",
        tool: str = "",
    ) -> dict[str, object]: ...

    async def read_history(
        self,
        session_id: str,
        item_id: int,
        offset: int = 0,
        limit: int = 4000,
    ) -> dict[str, object]: ...


class TokenCounter(Protocol):
    """计量完整请求，包括系统提示、消息与工具定义；允许保守估算。"""

    def count(self, request: LlmCompletionRequest) -> int: ...


class ArtifactStore(Protocol):
    """发布会话内不可变产物；返回引用之前必须确保已保存正文可读取。

    read/search 的偏移均按 UTF-8 字节计，下一页应使用返回的 next_offset。
    capture_complete 描述来源正文是否保存完整，不等同于预览是否被截断。
    """

    async def save(
        self,
        session_id: str,
        content: str,
        *,
        capture_complete: bool = True,
    ) -> dict[str, object]: ...

    async def read(
        self,
        session_id: str,
        artifact_id: str,
        offset: int = 0,
        limit: int = 4000,
    ) -> dict[str, object]: ...

    async def search(
        self,
        session_id: str,
        artifact_id: str,
        query: str,
        offset: int = 0,
    ) -> dict[str, object]: ...
