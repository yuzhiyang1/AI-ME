"""内置厂商与模型目录。

厂商（provider）只是元数据：认证来源、base_url、绑定的协议、模型清单。
新增一个 OpenAI 兼容厂商（如 Moonshot、Qwen、本地 Ollama）只需在这里
加条目并配一个 AIME_*_API_KEY 环境变量，零协议代码。

注意：模型 id、context_window 目前按常识手工维护，接入前建议核对
厂商官方文档；等厂商多了再考虑 pi 式的 JSON 数据目录 + 生成脚本。
"""

from dataclasses import dataclass

from aime.application.ports.model_gateway import ApiKind, ModelDescriptor


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    """厂商定义：元数据 + 绑定的协议。

    base_url 为 None 时使用协议 SDK 的默认地址；
    api_key_env 是启用该厂商的环境变量名（由 build_gateway_from_env 读取）。
    """

    provider: str  # 厂商 id，与模型引用 ref 的第一段一致，如 "openai"
    display_name: str  # 面向用户的厂商名
    api: ApiKind  # 绑定的协议；多家厂商可共享同一种协议
    base_url: str | None  # API 地址；None 用 SDK 默认（OpenAI 兼容服务通常需要覆盖）
    api_key_env: str  # 读取 API key 的环境变量名，约定为 AIME_<PROVIDER>_API_KEY
    models: tuple[ModelDescriptor, ...]  # 该厂商提供的模型清单（手工维护，接入前核对）


def _models(
    provider: str,
    api: ApiKind,
    entries: tuple[tuple[str, str, int], ...],
) -> tuple[ModelDescriptor, ...]:
    """从 (model_id, 显示名, 上下文窗口) 三元组批量生成模型元数据。"""
    return tuple(
        ModelDescriptor(
            provider=provider,
            model_id=model_id,
            api=api,
            display_name=display_name,
            context_window=context_window,
        )
        for model_id, display_name, context_window in entries
    )


OPENAI = ProviderDefinition(
    provider="openai",
    display_name="OpenAI",
    api=ApiKind.OPENAI_COMPLETIONS,
    base_url=None,
    api_key_env="AIME_OPENAI_API_KEY",
    models=_models(
        "openai",
        ApiKind.OPENAI_COMPLETIONS,
        (
            ("gpt-4o", "GPT-4o", 128_000),
            ("gpt-4o-mini", "GPT-4o mini", 128_000),
        ),
    ),
)

# DeepSeek 演示“新增厂商零协议代码”的路径：
# 与 OpenAI 完全同协议，只是 base_url 和 key 来源不同。
DEEPSEEK = ProviderDefinition(
    provider="deepseek",
    display_name="DeepSeek",
    api=ApiKind.OPENAI_COMPLETIONS,
    base_url="https://api.deepseek.com/v1",
    api_key_env="AIME_DEEPSEEK_API_KEY",
    models=_models(
        "deepseek",
        ApiKind.OPENAI_COMPLETIONS,
        (
            ("deepseek-chat", "DeepSeek Chat", 128_000),
            ("deepseek-reasoner", "DeepSeek Reasoner", 128_000),
        ),
    ),
)

ANTHROPIC = ProviderDefinition(
    provider="anthropic",
    display_name="Anthropic",
    api=ApiKind.ANTHROPIC_MESSAGES,
    base_url=None,
    api_key_env="AIME_ANTHROPIC_API_KEY",
    models=_models(
        "anthropic",
        ApiKind.ANTHROPIC_MESSAGES,
        (
            ("claude-sonnet-4-5", "Claude Sonnet 4.5", 200_000),
            ("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
        ),
    ),
)

# 装配时按此顺序构建运行时；list_models() 的输出顺序也随之确定
BUILTIN_PROVIDERS: tuple[ProviderDefinition, ...] = (OPENAI, DEEPSEEK, ANTHROPIC)
