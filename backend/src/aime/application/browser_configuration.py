"""Jev 设置持久化：独立配置、系统凭据和显式清除语义。"""

from uuid import uuid4

from aime.application.ports.browser import BrowserConfigurationRepository, BrowserPlanner
from aime.application.ports.model_configuration import ModelCredentialStore
from aime.domain.browser import BrowserConfiguration, BrowserError, BrowserUnavailable


class BrowserConfigurationService:
    def __init__(
        self, repository: BrowserConfigurationRepository, credentials: ModelCredentialStore,
        planner: BrowserPlanner, *, fallback_key: str = "", fallback_model: str = "jev-latest",
    ) -> None:
        self._repository = repository
        self._credentials = credentials
        self._planner = planner
        self._fallback_key = fallback_key
        self._fallback_model = fallback_model

    async def initialize(self) -> None:
        """只在从未保存设置时采用环境兜底；凭据丢失或清除均不能回退。"""
        configuration = await self._repository.get()
        if configuration is None:
            self._planner.configure(self._fallback_model, self._fallback_key)
            return
        key = ""
        if configuration.credential_id:
            try:
                key = await self._credentials.get(configuration.credential_id) or ""
            except Exception:
                # 凭据暂不可用不阻止整个工作台启动，设置页会显示未配置。
                pass
        self._planner.configure(configuration.model, key)

    async def save(self, model: str, api_key: str | None, clear_api_key: bool) -> None:
        """先存新凭据再原子替换元数据；失败不会改变运行中可见的配置。"""
        model = model.strip()
        if not model or len(model) > 200 or any(char.isspace() for char in model):
            raise BrowserError("Jev 模型名不能为空、不能包含空白且最长 200 字符")
        if clear_api_key and api_key is not None:
            raise BrowserError("不能同时设置和清除 API Key")
        if api_key is not None and (not api_key.strip() or len(api_key) > 8192):
            raise BrowserError("API Key 不能为空且最长 8192 字符")
        previous = await self._repository.get()
        old_id = previous.credential_id if previous else None
        new_id = old_id
        key = ""
        staged_id: str | None = None
        try:
            if clear_api_key:
                new_id = None
            elif api_key is not None:
                key = api_key.strip()
                staged_id = new_id = f"browser-jev-{uuid4()}"
                await self._credentials.set(new_id, key)
            elif old_id:
                key = await self._credentials.get(old_id) or ""
            elif previous is None and self._fallback_key:
                # 首次只修改模型名时，把环境密钥迁入凭据库，后续都由设置页管理。
                key = self._fallback_key
                staged_id = new_id = f"browser-jev-{uuid4()}"
                await self._credentials.set(new_id, key)
            await self._repository.save(BrowserConfiguration(model, new_id))
        except Exception:
            if staged_id:
                try:
                    await self._credentials.delete(staged_id)
                except Exception:
                    pass
            raise BrowserUnavailable("无法保存 Jev 配置，请检查数据库与系统凭据存储") from None
        self._planner.configure(model, key)
        if old_id and old_id != new_id:
            try:
                await self._credentials.delete(old_id)
            except Exception:
                # 元数据已经取消旧凭据引用；清理失败不能重新启用旧密钥。
                pass
