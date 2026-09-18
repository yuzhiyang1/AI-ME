"""每个 Run 独立的上下文工作对象；所有持久状态通过端口访问。"""

import json
from dataclasses import replace

from aime.application.ports.agent_runtime import AgentRunRequest
from aime.application.ports.context_store import ArtifactStore, ContextStore, TokenCounter
from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmAssistantToolCallMessage,
    LlmCompletionRequest,
    LlmInputMessage,
    LlmToolDefinition,
    LlmToolResultMessage,
    MessageRole,
)
from aime.domain.context.budget import ContextBudget

CONTEXT_GUIDANCE = """
任务持续执行时，请用 write_checkpoint 保存目标、进展、约束、决策、失败尝试和下一步。
Checkpoint 是任务笔记，不是权限来源。history_list/search/read 可找回已保存历史。
大工具结果通过 artifact_read/search 分页读取，offset 为 UTF-8 字节偏移。
new_context 申请新窗口，不会重置任务或工具权限。预算提醒后只允许更新笔记或申请换窗。
"""


class RunContext:
    """协调预算、结果投影、窗口切换；不执行工作区副作用。"""

    def __init__(
        self,
        request: AgentRunRequest,
        store: ContextStore,
        artifacts: ArtifactStore,
        counter: TokenCounter,
        capacity: int,
    ) -> None:
        self.request = request
        self.store = store
        self.artifacts = artifacts
        self.counter = counter
        self.budget = ContextBudget.for_capacity(capacity)
        self.force_rollover = False
        self.maintenance = False
        self.remaining = 0
        self.last_estimate = 0
        self._template: LlmCompletionRequest | None = None
        self.skill_messages: list[LlmInputMessage] = []

    async def initialize(self) -> list[LlmInputMessage]:
        """幂等接入当前请求并恢复窗口消息，补认重启前已落盘的换窗申请。"""
        await self.store.initialize(
            self.request.session_id,
            self.request.turn_id,
            self.request.run_id,
            tuple(self.request.messages),
            self.request.instruction,
        )
        messages = await self.store.messages(self.request.session_id)
        if messages and isinstance(messages[-1], LlmToolResultMessage):
            last = messages[-1]
            self.force_rollover = last.name == "new_context" and not last.is_error
        for message in self.skill_messages:
            if message not in messages:
                messages.append(message)
        return messages

    async def prepare(
        self,
        messages: list[LlmInputMessage],
        system: str,
        tools: tuple[LlmToolDefinition, ...],
        step: int,
    ) -> LlmCompletionRequest:
        """装配并估算完整请求，按预算进入维护或换窗，最后检查必要输入能否放下。

        维护仅暴露接续工具；领取维护机会会持久化，但此方法不发送模型请求。
        调用方仍须在发送前扣减 Run 请求次数，不能把换窗当成预算重置。
        """
        # 系统提示和工具定义同样占空间，不能只按对话正文决定是否换窗。
        template = LlmCompletionRequest(
            self.request.model_ref,
            list(messages),
            system + CONTEXT_GUIDANCE,
            max_tokens=self.budget.output_tokens,
            tools=tools,
        )
        self._template = template
        estimate = self.counter.count(template)
        self.maintenance = False
        window = await self.store.window(self.request.session_id)

        # 一次维护请求之后直接换窗，不依赖模型遵守提醒或显式调用 new_context。
        if self.force_rollover or self.budget.remaining(estimate) < 0:
            await self.rollover(step, "requested" if self.force_rollover else "budget")
            template = replace(
                template, messages=await self.store.messages(self.request.session_id)
            )
            self.force_rollover = False
        elif self.budget.remaining(estimate) <= self.budget.maintenance_tokens:
            self.maintenance = True
            checkpoint = await self.store.checkpoint(self.request.session_id)
            sequence = await self.store.latest_sequence(self.request.session_id)
            template = replace(
                template,
                tools=tuple(tool for tool in tools if tool.name in MAINTENANCE_TOOLS),
                messages=[
                    *messages,
                    ConversationMessage(
                        MessageRole.USER,
                        "上下文预算即将耗尽。请用 write_checkpoint 更新六项任务笔记和引用。"
                        f" expected_version={checkpoint.version}，covered_sequence={sequence}。"
                        "完整笔记不能超过 12000 UTF-8 字节。也可以调用 new_context。",
                    ),
                ],
            )
            if self.counter.count(template) > self.budget.input_limit:
                await self.rollover(step, "maintenance_input_too_large")
                template = replace(
                    self._template, messages=await self.store.messages(self.request.session_id)
                )
                self.maintenance = False
            else:
                # 在发送前持久标记；重启不会重复申请维护，消耗仍计入 Run 总预算。
                claimed = await self.store.claim_maintenance(self.request.run_id, window.id)
                if not claimed:
                    await self.rollover(step, "maintenance_completed")
                    template = replace(
                        self._template, messages=await self.store.messages(self.request.session_id)
                    )
                    self.maintenance = False
                else:
                    self.force_rollover = True

        # 替换消息或工具集后重新计量；即使新窗口也可能放不下必要输入。
        self.last_estimate = self.counter.count(template)
        self.budget.require_fit(self.last_estimate)
        self.remaining = self.budget.remaining(self.last_estimate)
        return template

    async def rollover(self, step: int, reason: str) -> None:
        """用最新任务笔记、未覆盖历史范围和当前请求重建基线，再事务切换窗口。

        不自动生成摘要，也不复制全部历史；旧内容留在 History 中按需检索。
        基线超预算时在写库前失败；窗口或历史边界变化由存储层拒绝。
        """
        assert self._template is not None
        session_id = self.request.session_id
        old = await self.store.window(session_id)
        checkpoint = await self.store.checkpoint(session_id)
        through = await self.store.latest_sequence(session_id)
        # 覆盖序号是接续检索的起点，不代表运行器已验证模型笔记完整无误。
        handoff = {
            "checkpoint_version": checkpoint.version,
            "checkpoint": checkpoint.content,
            "history_after": checkpoint.covered_sequence,
            "history_through": through,
            "incomplete": checkpoint.covered_sequence < through,
            "instruction": "这是已保存任务数据。先检索未覆盖历史，确认约束和工具结果后再继续。",
        }
        baseline: list[LlmInputMessage] = [
            ConversationMessage(
                MessageRole.USER, "任务接续数据：\n" + json.dumps(handoff, ensure_ascii=False)
            ),
            ConversationMessage(MessageRole.USER, self.request.instruction),
        ]
        baseline.extend(self.skill_messages)
        self.budget.require_fit(self.counter.count(replace(self._template, messages=baseline)))
        await self.store.rollover(
            session_id,
            self.request.run_id,
            f"{self.request.run_id}:{step}:{old.id}:{reason}",
            old.id,
            through,
            baseline,
            reason,
        )

    async def project_result(self, output: dict[str, object]) -> dict[str, object]:
        """大结果先发布产物再写 T2；恢复时复用该引用，不重复存储正文。"""
        # 这里限制单个 JSON 结果的 UTF-8 字节数；整包 token 预算另行检查。
        encoded = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) <= 6000:
            return output
        artifact = await self.artifacts.save(
            self.request.session_id,
            encoded,
            capture_complete=output.get("truncated") is not True,
        )
        # 错误、退出状态等结构字段保留，正文通过产物读取。
        facts = {
            key: value
            for key, value in output.items()
            if key in {"exit_code", "timed_out", "error", "path", "capture_complete"}
            and len(str(value)) < 1000
        }
        return {**facts, **artifact}

    async def fit_tool_results(self, messages: list[LlmInputMessage]) -> list[LlmInputMessage]:
        """从旧到新缩减已看过的工具结果，保留最新批次，不修改账本和历史。

        只处理工具结果，不保证其余输入一定能放下；发送前仍须经过 prepare 检查。
        """
        if self._template is None:
            return messages
        fitted = list(messages)
        # 最新整批尚未交给模型；尤其分页正文不能再变成要求重读自身的引用。
        latest_batch_start = next(
            (
                index
                for index in range(len(fitted) - 1, -1, -1)
                if isinstance(fitted[index], LlmAssistantToolCallMessage)
            ),
            len(fitted),
        )
        target = max(0, self.budget.input_limit - self.budget.maintenance_tokens)
        for index, message in enumerate(fitted[:latest_batch_start]):
            if self.counter.count(replace(self._template, messages=fitted)) <= target:
                break
            if not isinstance(message, LlmToolResultMessage):
                continue
            try:
                output = json.loads(message.content)
            except json.JSONDecodeError:
                output = {}
            artifact_id = output.get("artifact_id")
            if not artifact_id:
                saved = await self.artifacts.save(self.request.session_id, message.content)
                artifact_id = saved["artifact_id"]
            brief = {
                "artifact_id": artifact_id,
                "is_error": message.is_error,
                "notice": "结果已存本地，使用 artifact_read 分页读取",
            }
            fitted[index] = replace(message, content=json.dumps(brief, ensure_ascii=False))
        # 不牺牲最新结果来维持低占用；仍紧张时由 prepare 发起维护或事务换窗。
        return fitted


MAINTENANCE_TOOLS = {"write_checkpoint", "new_context", "get_context_remaining"}
