"""无厂商 tokenizer 时采用偏保守的 UTF-8 字节上界估算。"""

import json
from dataclasses import asdict

from aime.application.context.messages import encode_message
from aime.application.ports.model_gateway import LlmCompletionRequest


class ConservativeTokenCounter:
    """按 UTF-8 字节估算 token，并给每条消息及工具留协议余量。

    通常显著高估中英文文本；并不声称覆盖厂商隐藏前缀，因此仍保留安全余量和溢出兜底。
    """

    def count(self, request: LlmCompletionRequest) -> int:
        payload = {
            "system": request.system,
            "messages": [encode_message(message) for message in request.messages],
            "tools": [asdict(tool) for tool in request.tools],
        }
        size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        return size + 32 * (len(request.messages) + len(request.tools) + 1)
