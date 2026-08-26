"""模型流式输出事件的统一表示（参考 pi 的 AssistantMessageEvent 协议）。

所有厂商的分块方式（OpenAI 的 delta、Anthropic 的 content block）都会被
协议适配器翻译成这里的事件，上层（未来的 Agent Kernel）只面对这一种表示。
"""

from dataclasses import dataclass
from enum import StrEnum


class LlmEventType(StrEnum):
    """流事件类型。

    事件顺序契约：START -> 若干增量事件 -> DONE；
    任何环节出错则产出 ERROR 并立即终止，ERROR 之后不会再有事件。
    """

    # 流开始，恒为第一条事件，不带负载
    START = "start"
    # 正文增量（答案文本片段）
    TEXT_DELTA = "text_delta"
    # 思考增量（推理模型的 reasoning 内容片段，先于正文产出）
    THINKING_DELTA = "thinking_delta"
    # 预留：等 Agent Runtime 需要 tool use 时再实现翻译。
    # 到时和消费方一起定事件负载格式，比现在单方面定更稳。
    TOOL_CALL_DELTA = "tool_call_delta"
    # 流正常结束，不带负载
    DONE = "done"
    # 流异常终止，content 为错误描述，之后不再有事件
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class LlmStreamEvent:
    """一条流事件。content 仅对增量类事件（*_DELTA）和 ERROR 有意义。"""

    type: LlmEventType  # 事件种类，见 LlmEventType 的顺序契约
    content: str = ""  # 增量片段或错误描述；START/DONE 恒为空串

    # 便捷构造器：让协议适配器的翻译代码读起来是声明式的，
    # 同时把"事件类型与负载的对应关系"固定在这一处。

    @staticmethod
    def start() -> "LlmStreamEvent":
        return LlmStreamEvent(type=LlmEventType.START)

    @staticmethod
    def text(delta: str) -> "LlmStreamEvent":
        return LlmStreamEvent(type=LlmEventType.TEXT_DELTA, content=delta)

    @staticmethod
    def thinking(delta: str) -> "LlmStreamEvent":
        return LlmStreamEvent(type=LlmEventType.THINKING_DELTA, content=delta)

    @staticmethod
    def done() -> "LlmStreamEvent":
        return LlmStreamEvent(type=LlmEventType.DONE)

    @staticmethod
    def error(message: str) -> "LlmStreamEvent":
        return LlmStreamEvent(type=LlmEventType.ERROR, content=message)
