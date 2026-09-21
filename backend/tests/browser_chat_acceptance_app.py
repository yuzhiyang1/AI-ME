"""聊天浏览器联调夹具：只替换模型，工具、审批、执行桥和 SQLite 使用生产代码。"""

import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmCompletionRequest,
    LlmFinishReason,
    LlmStreamCompleted,
    LlmStreamEvent,
    LlmTextDelta,
    LlmToolCallDelta,
    LlmToolResultMessage,
    MessageRole,
    ModelDescriptor,
)
from aime.composition import build_container
from aime.main import create_app


class ChatBrowserGateway:
    """确定性选择工具，但最终结论必须来自真实页面回读。"""

    def list_models(self) -> list[ModelDescriptor]:
        return [ModelDescriptor("qa", "chat-browser", "聊天浏览器验收模型", 128000)]

    async def stream(self, request: LlmCompletionRequest) -> AsyncIterator[LlmStreamEvent]:
        origin = os.environ["AI_ME_CHAT_FIXTURE"]
        latest_user = max(
            index
            for index, message in enumerate(request.messages)
            if isinstance(message, ConversationMessage) and message.role is MessageRole.USER
        )
        user = request.messages[latest_user]
        assert isinstance(user, ConversationMessage)
        results = [
            message
            for message in request.messages[latest_user + 1 :]
            if isinstance(message, LlmToolResultMessage)
        ]
        if "导航" in user.content:
            steps = [("navigate", {"url": origin}), ("snapshot", {"origin": origin})]
            expected = "Password"
        else:
            steps = [
                ("snapshot", {"origin": origin}),
                ("type", {"origin": origin, "ref": "#user", "text": "tester"}),
                ("type", {"origin": origin, "ref": "#password", "credential": "test-password"}),
                ("click", {"origin": origin, "ref": "#login"}),
                ("wait", {"origin": origin, "text": "Signed in"}),
                ("click", {"origin": origin, "ref": "#create-record"}),
                ("wait", {"origin": origin, "text": "Record created: QA-001"}),
                ("extract", {"origin": origin}),
            ]
            expected = "Record created: QA-001"
        if results and results[-1].is_error:
            yield LlmTextDelta("验收失败：" + results[-1].content)
            yield LlmStreamCompleted(LlmFinishReason.STOP)
            return
        if len(results) < len(steps):
            operation, args = steps[len(results)]
            assert f"browser_{operation}" in {tool.name for tool in request.tools}
            yield LlmToolCallDelta(
                0,
                f"chat-browser-{latest_user}-{len(results)}",
                f"browser_{operation}",
                json.dumps(args),
            )
            yield LlmStreamCompleted(LlmFinishReason.TOOL_CALLS)
        else:
            assert expected in results[-1].content, "不能在没有页面证据时宣称成功"
            yield LlmTextDelta("已从内置浏览器回读验证：" + expected)
            yield LlmStreamCompleted(LlmFinishReason.STOP)


app = create_app(
    build_container(
        state_dir=Path(os.environ["AI_ME_ACCEPTANCE_DIR"]) / "state",
        model_gateway=ChatBrowserGateway(),
    )
)
