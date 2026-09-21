"""将不同 SDK 的异常归一化为稳定错误契约。"""

from aime.application.ports.model_gateway import LlmError, LlmErrorCategory, LlmFinishReason


def classify_provider_error(exc: Exception) -> LlmError:
    """按 HTTP 状态与异常名识别重试语义。"""
    status_code = getattr(exc, "status_code", None)
    name = type(exc).__name__.lower()
    body = getattr(exc, "body", None)
    error_body = body.get("error", body) if isinstance(body, dict) else {}
    code = error_body.get("code") if isinstance(error_body, dict) else None
    message = str(exc).lower()
    if status_code == 400 and (
        code == "context_length_exceeded"
        or "maximum context length" in message
        or "prompt is too long" in message
        or "input is too long" in message
    ):
        return LlmError(
            LlmErrorCategory.INVALID_REQUEST,
            "context_window_exceeded",
            str(exc),
            False,
        )

    if status_code in {401, 403}:
        return LlmError(LlmErrorCategory.AUTHENTICATION, "authentication_failed", str(exc), False)
    if status_code == 429:
        return LlmError(LlmErrorCategory.RATE_LIMIT, "rate_limited", str(exc), True)
    if status_code == 408 or "timeout" in name:
        return LlmError(LlmErrorCategory.TIMEOUT, "provider_timeout", str(exc), True)
    if "connection" in name:
        return LlmError(LlmErrorCategory.CONNECTION, "connection_failed", str(exc), True)
    if isinstance(status_code, int) and status_code >= 500:
        return LlmError(LlmErrorCategory.PROVIDER, "provider_unavailable", str(exc), True)
    if isinstance(status_code, int) and 400 <= status_code < 500:
        return LlmError(
            LlmErrorCategory.INVALID_REQUEST, "provider_rejected_request", str(exc), False
        )
    return LlmError(LlmErrorCategory.UNKNOWN, "provider_error", str(exc), False)


def normalize_finish_reason(reason: str | None) -> LlmFinishReason:
    """将 OpenAI 与 Anthropic 的结束原因映射到统一枚举。"""
    mapping = {
        None: LlmFinishReason.STOP,
        "stop": LlmFinishReason.STOP,
        "stop_sequence": LlmFinishReason.STOP,
        "end_turn": LlmFinishReason.STOP,
        "length": LlmFinishReason.LENGTH,
        "max_tokens": LlmFinishReason.LENGTH,
        "tool_calls": LlmFinishReason.TOOL_CALLS,
        "tool_use": LlmFinishReason.TOOL_CALLS,
        "content_filter": LlmFinishReason.CONTENT_FILTER,
        "pause_turn": LlmFinishReason.PAUSE,
    }
    return mapping.get(reason, LlmFinishReason.OTHER)
