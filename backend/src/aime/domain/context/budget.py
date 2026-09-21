"""预算只使用 token 单位；字节限制由存储和采集层单独负责。"""

from dataclasses import dataclass


class ContextError(ValueError):
    """可向用户解释的上下文错误，code 用于稳定分类。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True, slots=True)
class ContextBudget:
    """一次请求的预算；输出和维护空间均来自模型的真实容量。"""

    capacity: int
    output_tokens: int
    safety_tokens: int
    maintenance_tokens: int

    @classmethod
    def for_capacity(cls, capacity: int) -> "ContextBudget":
        """按模型容量分配输出、安全及维护额度；未知容量不能凭默认值继续执行。"""
        if capacity <= 0:
            raise ContextError("context_capacity_unknown", "模型必须配置有效上下文容量")
        return cls(
            capacity,
            min(4096, max(256, capacity // 8)),
            max(256, capacity // 20),
            min(4096, max(512, capacity // 8)),
        )

    @property
    def input_limit(self) -> int:
        """可发送输入的硬上限；维护额度在此范围内，不额外扩大模型容量。"""
        return self.capacity - self.output_tokens - self.safety_tokens

    def remaining(self, input_tokens: int) -> int:
        """返回扣除输出和安全空间后的输入余额，负数表示必须缩减或换窗。"""
        return self.input_limit - input_tokens

    def require_fit(self, input_tokens: int) -> None:
        """必要输入仍超预算时明确失败，避免反复换到同样放不下的新窗口。"""
        if self.remaining(input_tokens) < 0:
            raise ContextError(
                "context_base_too_large",
                f"必要输入估算 {input_tokens} token，超过输入预算 {self.input_limit}；"
                "请缩小输入或选择更大上下文的模型",
            )
