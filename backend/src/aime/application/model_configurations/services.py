"""新增、读取和启动本地模型配置。"""

import logging
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import uuid4

from aime.application.ports.model_configuration import (
    ModelConfigurationRepository,
    ModelCredentialStore,
    ModelRuntimeConfigurator,
)
from aime.domain.model_configurations.entities import ModelConfiguration, ModelProtocol

_PROVIDER_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
logger = logging.getLogger(__name__)


class ModelCredentialUnavailable(RuntimeError):
    """系统凭据存储不可用或配置密钥已经丢失。"""


@dataclass(frozen=True, slots=True)
class CreateModelConfigurationCommand:
    """创建本地模型所需的全部输入；API Key 不进入领域实体。"""

    provider: str
    model_id: str
    display_name: str
    protocol: ModelProtocol
    base_url: str | None
    api_key: str = field(repr=False)
    context_window: int


@dataclass(frozen=True, slots=True)
class ModelConfigurationView:
    """设置页需要的模型元数据和凭据可用状态。"""

    configuration: ModelConfiguration
    credential_stored: bool


class ModelConfigurationService:
    """协调非敏感元数据、系统凭据和当前模型网关。"""

    def __init__(
        self,
        repository: ModelConfigurationRepository,
        credential_store: ModelCredentialStore,
        runtime_configurator: ModelRuntimeConfigurator,
    ) -> None:
        self._repository = repository
        self._credential_store = credential_store
        self._runtime_configurator = runtime_configurator

    async def initialize(self) -> None:
        """应用启动时恢复可用配置；丢失密钥的记录保留给设置页修复。"""
        for configuration in await self._repository.list_all():
            try:
                api_key = await self._credential_store.get(str(configuration.id))
            except Exception:
                logger.exception("无法恢复模型配置凭据：%s", configuration.model_ref)
                continue
            if api_key:
                self._runtime_configurator.activate(configuration, api_key)

    async def list(self) -> list[ModelConfigurationView]:
        """列出配置时只返回密钥是否存在，绝不返回密钥内容。"""
        result: list[ModelConfigurationView] = []
        for configuration in await self._repository.list_all():
            try:
                api_key = await self._credential_store.get(str(configuration.id))
            except Exception as exc:
                raise ModelCredentialUnavailable("无法读取系统凭据保险库") from exc
            result.append(ModelConfigurationView(configuration, bool(api_key)))
        return result

    async def create(self, command: CreateModelConfigurationCommand) -> ModelConfigurationView:
        """保存并激活配置；同一引用再次保存时安全轮换密钥。"""
        configuration, api_key = _build_configuration(command)
        existing = await self._repository.get_by_ref(configuration.model_ref)
        previous_api_key: str | None = None
        if existing is not None:
            configuration = replace(
                configuration,
                id=existing.id,
                created_at=existing.created_at,
            )
            try:
                previous_api_key = await self._credential_store.get(str(existing.id))
            except Exception as exc:
                raise ModelCredentialUnavailable("无法读取系统凭据保险库") from exc

        self._runtime_configurator.activate(configuration, api_key)
        try:
            await self._credential_store.set(str(configuration.id), api_key)
        except Exception as exc:
            self._runtime_configurator.deactivate(configuration.model_ref)
            if existing is not None and previous_api_key:
                self._runtime_configurator.activate(existing, previous_api_key)
                try:
                    await self._credential_store.set(str(existing.id), previous_api_key)
                except Exception:
                    pass
            raise ModelCredentialUnavailable("无法写入系统凭据保险库") from exc
        try:
            await self._repository.save(configuration)
        except Exception:
            self._runtime_configurator.deactivate(configuration.model_ref)
            if existing is not None and previous_api_key:
                await self._credential_store.set(str(existing.id), previous_api_key)
                self._runtime_configurator.activate(existing, previous_api_key)
            else:
                await self._credential_store.delete(str(configuration.id))
            raise
        return ModelConfigurationView(configuration, True)


def _build_configuration(
    command: CreateModelConfigurationCommand,
) -> tuple[ModelConfiguration, str]:
    """规范化并校验外部输入，确保模型引用和地址可安全持久化。"""
    provider = command.provider.strip().lower()
    model_id = command.model_id.strip()
    display_name = command.display_name.strip()
    api_key = command.api_key.strip()
    base_url = command.base_url.strip().rstrip("/") if command.base_url else None

    if _PROVIDER_PATTERN.fullmatch(provider) is None:
        raise ValueError("厂商标识只能包含小写字母、数字、下划线和连字符")
    if not model_id or len(model_id) > 200 or any(character.isspace() for character in model_id):
        raise ValueError("模型 ID 不能为空、不能包含空白且最长 200 个字符")
    if not display_name or len(display_name) > 200:
        raise ValueError("模型显示名称不能为空且最长 200 个字符")
    if not api_key or len(api_key) > 8192:
        raise ValueError("API Key 不能为空且最长 8192 个字符")
    if not 1 <= command.context_window <= 10_000_000:
        raise ValueError("上下文窗口必须在 1 到 10000000 之间")
    if base_url:
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("API 地址必须是有效的 HTTP 或 HTTPS 地址")

    now = datetime.now(UTC)
    return (
        ModelConfiguration(
            id=uuid4(),
            provider=provider,
            model_id=model_id,
            display_name=display_name,
            protocol=command.protocol,
            base_url=base_url,
            context_window=command.context_window,
            created_at=now,
            updated_at=now,
        ),
        api_key,
    )
