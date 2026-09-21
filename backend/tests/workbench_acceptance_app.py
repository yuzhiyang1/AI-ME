"""桌面验收后端；必须显式给出独立目录，不能回落到用户状态或模型。"""

import json
import os
from pathlib import Path

from aime.application.ports.model_gateway import (
    LlmFinishReason,
    LlmStreamCompleted,
    LlmTextDelta,
    ModelDescriptor,
)
from aime.composition import build_container
from aime.main import create_app


class AcceptanceGateway:
    """确定性响应只证明 Skill 正文到达模型请求，不调用付费模型。"""

    def list_models(self):
        return [ModelDescriptor("qa", "workbench", "工作台验收模型", 128000)]

    async def stream(self, request):
        visible = json.dumps([str(message) for message in request.messages], ensure_ascii=False)
        text = (
            "验收完成：已加载 REVIEW_PROBE 技能"
            if "REVIEW_PROBE" in visible
            else "验收完成：普通会话"
        )
        yield LlmTextDelta(text)
        yield LlmStreamCompleted(LlmFinishReason.STOP)


state = Path(os.environ["AI_ME_ACCEPTANCE_DIR"]).resolve()
app = create_app(
    build_container(state_dir=state / "state", model_gateway=AcceptanceGateway()),
    frontend_dist=Path(__file__).resolve().parents[2] / "frontend" / "dist",
)
