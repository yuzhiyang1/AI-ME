"""使用操作系统凭据保险库保存模型 API Key。"""

import keyring
from anyio import to_thread
from keyring.errors import PasswordDeleteError

_SERVICE_NAME = "AI-ME model configuration"


class SystemModelCredentialStore:
    """Windows 上由 Credential Locker 加密持久化模型密钥。"""

    async def get(self, configuration_id: str) -> str | None:
        return await to_thread.run_sync(keyring.get_password, _SERVICE_NAME, configuration_id)

    async def set(self, configuration_id: str, api_key: str) -> None:
        await to_thread.run_sync(keyring.set_password, _SERVICE_NAME, configuration_id, api_key)

    async def delete(self, configuration_id: str) -> None:
        try:
            await to_thread.run_sync(keyring.delete_password, _SERVICE_NAME, configuration_id)
        except PasswordDeleteError:
            return
