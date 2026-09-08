"""本地模型配置所需的持久化、凭据和运行时端口。"""

from typing import Protocol

from aime.domain.model_configurations.entities import ModelConfiguration


class ModelConfigurationRepository(Protocol):
    """只保存非敏感模型元数据。"""

    async def list_all(self) -> list[ModelConfiguration]: ...

    async def get_by_ref(self, model_ref: str) -> ModelConfiguration | None: ...

    async def save(self, configuration: ModelConfiguration) -> None: ...


class ModelCredentialStore(Protocol):
    """把 API Key 与普通应用数据库隔离的系统凭据存储。"""

    async def get(self, configuration_id: str) -> str | None: ...

    async def set(self, configuration_id: str, api_key: str) -> None: ...

    async def delete(self, configuration_id: str) -> None: ...


class ModelRuntimeConfigurator(Protocol):
    """让持久配置即时进入或退出当前模型网关。"""

    def activate(self, configuration: ModelConfiguration, api_key: str) -> None: ...

    def deactivate(self, model_ref: str) -> None: ...
