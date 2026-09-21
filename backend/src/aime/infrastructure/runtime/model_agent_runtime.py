"""带工具循环的 AI-ME 本地 Agent Runtime。"""

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from uuid import UUID

from aime.application.ports.agent_runtime import AgentEvent, AgentRunRequest, AgentRuntime
from aime.application.ports.model_gateway import (
    LlmAssistantToolCallMessage,
    LlmCompletionRequest,
    LlmFinishReason,
    LlmInputMessage,
    LlmStreamCompleted,
    LlmStreamFailed,
    LlmTextDelta,
    LlmToolCall,
    LlmToolCallDelta,
    LlmToolResultMessage,
    ModelGateway,
)
from aime.application.ports.tool_execution import (
    ToolDescriptor,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolExecutionSemantics,
    ToolRegistry,
)
from aime.application.ports.tool_execution_store import ApprovalBroker, ToolExecutionStore
from aime.domain.tool_execution.value_objects import (
    ApprovalStatus,
    ToolInvocationStatus,
)
from aime.infrastructure.tools.builtin import BuiltInToolRegistry, ToolInputError

DEFAULT_MAX_STEPS = 32
REPEATED_FAILURE_LIMIT = 3
MAX_TOOL_CALLS_PER_STEP = 16
MAX_TOOL_ARGUMENT_CHARS = 100_000
MAX_MODEL_TEXT_CHARS = 1_000_000
SYSTEM_PROMPT = """你是 AI-ME，一个在固定本地工作区中协助用户完成任务的 Agent。
需要查看或修改文件时必须使用提供的工具，不要假装执行。先检查再修改；工具失败时根据错误调整参数。
所有路径优先使用相对工作区路径。完成任务后用简洁中文说明结果和验证情况。"""


def _system_prompt(request: AgentRunRequest) -> str:
    """把 Session 目录快照以确定性格式写入本轮系统指令。"""
    roots = request.workspace_roots or (request.workspace_path,)
    additional = roots[1:]
    additional_text = "\n".join(f"- {root}" for root in additional) if additional else "- 无"
    return (
        f"{SYSTEM_PROMPT}\n\n"
        f"当前会话主目录：{roots[0]}\n"
        f"附加授权目录：\n{additional_text}\n"
        "相对工具路径默认相对于主目录；访问附加目录时使用绝对路径。"
    )


@dataclass(slots=True)
class _PendingToolCall:
    """把厂商的分片工具调用拼成完整调用。"""

    index: int
    call_id: str = ""
    name: str = ""
    arguments_json: str = ""


@dataclass(frozen=True, slots=True)
class _ExecutedCall:
    """一次工具执行及其回填模型的结果。"""

    call: LlmToolCall
    result: ToolExecutionResult


class ModelAgentRuntime(AgentRuntime):
    """驱动模型、工具和结果回填，直到得到最终文本或触发循环保护。"""

    def __init__(
        self,
        gateway: ModelGateway,
        tool_store: ToolExecutionStore,
        approval_broker: ApprovalBroker,
        tool_registry: ToolRegistry | None = None,
        *,
        max_steps: int = DEFAULT_MAX_STEPS,
    ) -> None:
        self._gateway = gateway
        self._tool_store = tool_store
        self._approval_broker = approval_broker
        self._tool_registry = tool_registry or BuiltInToolRegistry()
        self._max_steps = max_steps

    async def run(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        """执行有界 Agent Loop，并在每次副作用前先发出可持久化 T1 事件。"""
        messages: list[LlmInputMessage] = list(request.messages)
        descriptors = self._tool_registry.descriptors(request.permission_profile)
        context = ToolExecutionContext(
            session_id=request.session_id,
            turn_id=request.turn_id,
            run_id=request.run_id,
            workspace_path=request.workspace_path,
            permission_profile=request.permission_profile,
            workspace_roots=request.workspace_roots or (request.workspace_path,),
        )
        last_failure_signature: str | None = None
        repeated_failures = 0
        first_new_step = 1
        context_window = next(
            (
                model.context_window
                for model in self._gateway.list_models()
                if model.ref == request.model_ref
            ),
            None,
        )

        # 重启后从 T1/T2 账本重建尚未完成的模型步骤，不重新请求模型生成危险调用。
        existing = await self._tool_store.list_run_invocations(UUID(request.run_id))
        if existing and not any(
            invocation.status is ToolInvocationStatus.WAITING_FOR_APPROVAL
            for invocation in existing
        ):
            yield AgentEvent(
                type="runtime_resumed",
                payload={"runId": request.run_id, "reason": "tool_ledger_recovery"},
            )
        existing_steps = sorted({invocation.step_index for invocation in existing})
        for existing_step in existing_steps:
            step_invocations = [
                invocation for invocation in existing if invocation.step_index == existing_step
            ]
            step_invocations.sort(key=lambda invocation: invocation.call_index)
            calls = tuple(
                LlmToolCall(
                    call_id=invocation.call_id,
                    name=invocation.tool_name,
                    arguments_json=json.dumps(
                        invocation.arguments,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                )
                for invocation in step_invocations
            )
            assistant_text = step_invocations[0].assistant_text
            messages.append(LlmAssistantToolCallMessage(calls, assistant_text))
            async for runtime_event, executed in self._execute_step(
                calls,
                descriptors,
                context,
                existing_step,
                assistant_text,
            ):
                if runtime_event is not None:
                    yield runtime_event
                if executed is not None:
                    messages.append(
                        LlmToolResultMessage(
                            call_id=executed.call.call_id,
                            name=executed.call.name,
                            content=json.dumps(
                                executed.result.model_output,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ),
                            is_error=executed.result.is_error,
                        )
                    )
            first_new_step = max(first_new_step, existing_step + 1)

        for step in range(first_new_step, self._max_steps + 1):
            text_parts: list[str] = []
            text_chars = 0
            pending_calls: dict[int, _PendingToolCall] = {}
            completed: LlmStreamCompleted | None = None
            provider_stream = self._gateway.stream(
                LlmCompletionRequest(
                    model_ref=request.model_ref,
                    messages=messages,
                    system=_system_prompt(request),
                    tools=tuple(descriptor.definition for descriptor in descriptors),
                    parallel_tool_calls=True,
                )
            )
            async for event in provider_stream:
                if isinstance(event, LlmTextDelta):
                    text_chars += len(event.delta)
                    if text_chars > MAX_MODEL_TEXT_CHARS:
                        yield AgentEvent(type="failed", content="模型单步文本超过 Runtime 上限")
                        return
                    text_parts.append(event.delta)
                    # Provider 文本必须边接收边发布；完整缓冲只用于工具回填和最终持久化。
                    yield AgentEvent(type="text_delta", content=event.delta)
                elif isinstance(event, LlmToolCallDelta):
                    call = pending_calls.setdefault(event.index, _PendingToolCall(event.index))
                    if len(pending_calls) > MAX_TOOL_CALLS_PER_STEP:
                        yield AgentEvent(
                            type="failed",
                            content=f"模型单步工具调用超过上限 {MAX_TOOL_CALLS_PER_STEP}",
                        )
                        return
                    if event.call_id:
                        call.call_id = event.call_id
                    if event.name:
                        call.name = event.name
                    call.arguments_json += event.arguments_delta
                    if len(call.arguments_json) > MAX_TOOL_ARGUMENT_CHARS:
                        yield AgentEvent(type="failed", content="工具参数超过 Runtime 上限")
                        return
                elif isinstance(event, LlmStreamFailed):
                    yield AgentEvent(type="failed", content=event.error.message)
                    return
                elif isinstance(event, LlmStreamCompleted):
                    completed = event

            if completed is not None:
                # 每个模型步骤独立落账；累计费用与最新上下文不能混成同一个数字。
                yield AgentEvent(
                    type="model_usage",
                    payload={
                        "step": step,
                        "modelRef": request.model_ref,
                        "inputTokens": (
                            completed.usage.input_tokens
                            if completed.usage is not None
                            else None
                        ),
                        "outputTokens": (
                            completed.usage.output_tokens
                            if completed.usage is not None
                            else None
                        ),
                        "contextWindow": context_window,
                    },
                )

            calls = tuple(
                LlmToolCall(
                    call_id=call.call_id or f"step-{step}-call-{call.index}",
                    name=call.name,
                    arguments_json=call.arguments_json or "{}",
                )
                for call in sorted(pending_calls.values(), key=lambda item: item.index)
            )
            assistant_text = "".join(text_parts)
            if calls:
                messages.append(
                    LlmAssistantToolCallMessage(tool_calls=calls, content=assistant_text)
                )
                async for runtime_event, executed in self._execute_step(
                    calls, descriptors, context, step, assistant_text
                ):
                    if runtime_event is not None:
                        yield runtime_event
                    if executed is not None:
                        result_content = json.dumps(
                            executed.result.model_output,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        messages.append(
                            LlmToolResultMessage(
                                call_id=executed.call.call_id,
                                name=executed.call.name,
                                content=result_content,
                                is_error=executed.result.is_error,
                            )
                        )
                        if executed.result.is_error:
                            signature = (
                                f"{executed.call.name}:"
                                f"{_canonical_arguments(executed.call.arguments_json)}"
                            )
                            if signature == last_failure_signature:
                                repeated_failures += 1
                            else:
                                last_failure_signature = signature
                                repeated_failures = 1
                            if repeated_failures >= REPEATED_FAILURE_LIMIT:
                                yield AgentEvent(
                                    type="failed",
                                    content=(
                                        "同一工具和参数已连续失败 3 次，Runtime 已停止循环："
                                        f"{executed.call.name}"
                                    ),
                                )
                                return
                        else:
                            last_failure_signature = None
                            repeated_failures = 0
                continue

            if completed is not None and completed.finish_reason is LlmFinishReason.TOOL_CALLS:
                yield AgentEvent(
                    type="failed", content="模型结束原因为 tool_calls，但未提供工具调用"
                )
                return
            if not assistant_text.strip():
                yield AgentEvent(type="failed", content="模型未返回可显示内容")
                return
            return

        yield AgentEvent(type="failed", content=f"Agent Loop 已达到最大步骤数 {self._max_steps}")

    async def _execute_step(
        self,
        calls: tuple[LlmToolCall, ...],
        descriptors: tuple[ToolDescriptor, ...],
        context: ToolExecutionContext,
        step: int,
        assistant_text: str,
    ) -> AsyncIterator[tuple[AgentEvent | None, _ExecutedCall | None]]:
        """按 Codex 风格调度并行工具，独占工具混用时按 Maka 语义拒绝整步。"""
        available = {descriptor.definition.name: descriptor for descriptor in descriptors}
        resolved = [available.get(call.name) for call in calls]
        exclusive = [
            descriptor
            for descriptor in resolved
            if descriptor is not None
            and descriptor.execution_semantics is ToolExecutionSemantics.EXCLUSIVE_STEP
        ]
        if exclusive and len(calls) != 1:
            message = "exclusive_step 工具必须在单独的模型步骤中调用"
            yield (
                AgentEvent(
                    type="tool_step_rejected",
                    payload={"step": step, "reason": message},
                ),
                None,
            )
            for call in calls:
                yield None, _ExecutedCall(call, _error_result("exclusive_step_mixed", message))
            return

        runnable: list[tuple[LlmToolCall, dict[str, object], UUID]] = []
        immediate: dict[str, ToolExecutionResult] = {}
        for call_index, call in enumerate(calls):
            descriptor = available.get(call.name)
            if descriptor is None:
                immediate[call.call_id] = _error_result(
                    "tool_not_available",
                    f"工具不存在或当前权限不允许调用：{call.name or '<empty>'}",
                )
                continue
            try:
                arguments = _decode_arguments(call.arguments_json)
                _validate_arguments(arguments, descriptor.definition.input_schema)
            except ToolInputError as exc:
                immediate[call.call_id] = _error_result("invalid_arguments", str(exc))
                continue
            invocation = await self._tool_store.prepare_invocation(
                context,
                call,
                descriptor,
                arguments,
                step_index=step,
                call_index=call_index,
                assistant_text=assistant_text,
            )
            yield (
                AgentEvent(
                    type="tool_prepared",
                    payload={
                        "step": step,
                        "callId": call.call_id,
                        "name": call.name,
                        "arguments": arguments,
                        "executionSemantics": descriptor.execution_semantics.value,
                        "invocationId": str(invocation.id),
                    },
                ),
                None,
            )
            if invocation.status in {
                ToolInvocationStatus.COMPLETED,
                ToolInvocationStatus.FAILED,
                ToolInvocationStatus.REJECTED,
            }:
                immediate[call.call_id] = ToolExecutionResult(
                    invocation.result
                    or {"error": {"code": "missing_result", "message": "账本缺少结果"}},
                    is_error=bool(invocation.is_error),
                )
                continue

            approval_reason = _approval_reason(call.name, arguments)
            has_grant = await self._tool_store.has_session_grant(
                UUID(context.session_id), call.name
            )
            if approval_reason is not None and not has_grant:
                approval = await self._tool_store.get_approval_for_invocation(invocation.id)
                if approval is None:
                    approval = await self._tool_store.request_approval(
                        invocation.id, approval_reason
                    )
                if approval.status is ApprovalStatus.PENDING:
                    yield (
                        AgentEvent(
                            type="approval_required",
                            payload={
                                "approvalId": str(approval.id),
                                "invocationId": str(invocation.id),
                                "callId": call.call_id,
                                "name": call.name,
                                "reason": approval.reason,
                            },
                        ),
                        None,
                    )
                    decision = await self._approval_broker.wait(approval.id)
                    yield (
                        AgentEvent(
                            type="approval_resolved",
                            payload={
                                "approvalId": str(approval.id),
                                "decision": decision.value,
                            },
                        ),
                        None,
                    )
                    invocation = await self._tool_store.get_invocation(invocation.id)
                if invocation.status is ToolInvocationStatus.REJECTED:
                    immediate[call.call_id] = ToolExecutionResult(
                        invocation.result
                        or {
                            "error": {
                                "code": "approval_rejected",
                                "message": "用户拒绝执行",
                            }
                        },
                        is_error=True,
                    )
                    continue
            runnable.append((call, arguments, invocation.id))

        for call, _, invocation_id in runnable:
            await self._tool_store.mark_running(invocation_id)
            yield (
                AgentEvent(
                    type="tool_started",
                    payload={
                        "step": step,
                        "callId": call.call_id,
                        "name": call.name,
                        "invocationId": str(invocation_id),
                    },
                ),
                None,
            )

        tasks = [self._execute_one(call, arguments, context) for call, arguments, _ in runnable]
        results = await asyncio.gather(*tasks) if tasks else []
        by_call_id = {executed.call.call_id: executed for executed in results}
        invocation_ids = {call.call_id: invocation_id for call, _, invocation_id in runnable}

        # 并行执行但按模型原调用顺序回填，避免时序抖动影响下一轮推理。
        for call in calls:
            result = immediate.get(call.call_id)
            executed = by_call_id.get(call.call_id)
            if result is None and executed is not None:
                result = executed.result
            if result is None:
                result = _error_result("tool_dispatch_failed", "工具没有产生可用结果")
            finished_invocation_id = invocation_ids.get(call.call_id)
            if finished_invocation_id is not None:
                await self._tool_store.finish_invocation(finished_invocation_id, result)
            event_type = "tool_failed" if result.is_error else "tool_completed"
            yield (
                AgentEvent(
                    type=event_type,
                    payload={
                        "step": step,
                        "callId": call.call_id,
                        "name": call.name,
                        "result": result.output,
                        "invocationId": (
                            str(finished_invocation_id)
                            if finished_invocation_id is not None
                            else None
                        ),
                    },
                ),
                _ExecutedCall(call, result),
            )

    async def _execute_one(
        self,
        call: LlmToolCall,
        arguments: dict[str, object],
        context: ToolExecutionContext,
    ) -> _ExecutedCall:
        """把工具自身错误收敛为模型可修正的结果，不击穿整个 Run。"""
        tool = self._tool_registry.get(call.name)
        if tool is None:
            return _ExecutedCall(call, _error_result("tool_not_found", f"工具不存在：{call.name}"))
        try:
            result = await tool.execute(arguments, context)
        except ToolInputError as exc:
            result = _error_result("invalid_arguments", str(exc))
        except UnicodeError as exc:
            result = _error_result("unsupported_encoding", f"文件不是有效 UTF-8 文本：{exc}")
        except OSError as exc:
            result = _error_result("io_error", str(exc))
        except Exception as exc:  # noqa: BLE001 - 工具边界必须转换为可审计错误
            result = _error_result("tool_error", str(exc))
        return _ExecutedCall(call, result)


def _decode_arguments(arguments_json: str) -> dict[str, object]:
    try:
        decoded = json.loads(arguments_json)
    except json.JSONDecodeError as exc:
        raise ToolInputError(f"工具参数不是有效 JSON：{exc.msg}") from exc
    if not isinstance(decoded, dict):
        raise ToolInputError("工具参数必须是 JSON 对象")
    return decoded


def _canonical_arguments(arguments_json: str) -> str:
    try:
        return json.dumps(json.loads(arguments_json), sort_keys=True, separators=(",", ":"))
    except json.JSONDecodeError:
        return arguments_json


def _validate_arguments(arguments: dict[str, object], input_schema: dict[str, object]) -> None:
    """校验内置工具使用的 JSON Schema 子集，阻止未知和明显错误参数。"""
    properties_value = input_schema.get("properties", {})
    properties = properties_value if isinstance(properties_value, dict) else {}
    required_value = input_schema.get("required", [])
    required = required_value if isinstance(required_value, list) else []
    missing = [name for name in required if isinstance(name, str) and name not in arguments]
    if missing:
        raise ToolInputError(f"缺少必填参数：{', '.join(missing)}")
    if input_schema.get("additionalProperties") is False:
        unknown = sorted(set(arguments) - set(properties))
        if unknown:
            raise ToolInputError(f"包含未知参数：{', '.join(unknown)}")
    for name, value in arguments.items():
        rule_value = properties.get(name)
        if not isinstance(rule_value, dict):
            continue
        expected_type = rule_value.get("type")
        valid = (
            (expected_type == "string" and isinstance(value, str))
            or (expected_type == "boolean" and isinstance(value, bool))
            or (
                expected_type == "integer"
                and isinstance(value, int)
                and not isinstance(value, bool)
            )
            or (expected_type == "object" and isinstance(value, dict))
            or (expected_type == "array" and isinstance(value, list))
            or expected_type is None
        )
        if not valid:
            raise ToolInputError(f"参数 {name} 类型错误，预期 {expected_type}")
        if isinstance(value, int) and not isinstance(value, bool):
            minimum = rule_value.get("minimum")
            maximum = rule_value.get("maximum")
            if isinstance(minimum, int) and value < minimum:
                raise ToolInputError(f"参数 {name} 不能小于 {minimum}")
            if isinstance(maximum, int) and value > maximum:
                raise ToolInputError(f"参数 {name} 不能大于 {maximum}")


def _error_result(code: str, message: str) -> ToolExecutionResult:
    return ToolExecutionResult({"error": {"code": code, "message": message}}, is_error=True)


def _approval_reason(tool_name: str, arguments: dict[str, object]) -> str | None:
    """返回需要用户明确确认的风险说明；None 表示可按当前档位自动执行。"""
    if tool_name == "run_powershell":
        command = str(arguments.get("command", ""))
        preview = command if len(command) <= 300 else f"{command[:300]}…"
        return f"PowerShell 可以修改文件、访问网络或启动进程。即将执行：{preview}"
    if tool_name == "write_file" and arguments.get("overwrite") is True:
        return f"即将覆盖已有文件：{arguments.get('path', '')}"
    if tool_name == "edit_file" and arguments.get("new_text") == "":
        return f"即将从文件中删除匹配内容：{arguments.get('path', '')}"
    if tool_name == "edit_file" and arguments.get("replace_all") is True:
        return f"即将在文件中批量替换全部匹配内容：{arguments.get('path', '')}"
    return None
