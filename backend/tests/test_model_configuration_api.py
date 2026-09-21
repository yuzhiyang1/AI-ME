"""通过公开 HTTP API 验证本地模型配置。"""

from pathlib import Path

from fastapi.testclient import TestClient

from aime.composition import build_container
from aime.main import create_app


class _MemoryCredentialStore:
    """测试专用凭据存储，避免接触开发机系统凭据。"""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.fail_get = False
        self.fail_set = False

    async def get(self, configuration_id: str) -> str | None:
        if self.fail_get:
            raise RuntimeError("credential store unavailable")
        return self.values.get(configuration_id)

    async def set(self, configuration_id: str, api_key: str) -> None:
        if self.fail_set:
            raise RuntimeError("credential store unavailable")
        self.values[configuration_id] = api_key

    async def delete(self, configuration_id: str) -> None:
        self.values.pop(configuration_id, None)


def test_user_can_add_a_model_without_environment_variables(tmp_path: Path) -> None:
    """保存后应立即出现在模型列表中，且任何响应都不能回传 API Key。"""
    credential_store = _MemoryCredentialStore()
    app = create_app(
        build_container(
            state_dir=tmp_path / "state",
            model_credential_store=credential_store,
        )
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/settings/models",
            json={
                "provider": "local-openai",
                "modelId": "qwen3-coder",
                "displayName": "本地 Qwen3 Coder",
                "protocol": "openai_completions",
                "baseUrl": "http://127.0.0.1:11434/v1",
                "apiKey": "never-return-this-secret",
                "contextWindow": 131072,
            },
        )

        assert response.status_code == 201
        saved = response.json()
        assert saved["modelRef"] == "local-openai/qwen3-coder"
        assert saved["credentialStored"] is True
        assert "apiKey" not in saved
        assert "never-return-this-secret" not in response.text

        models = client.get("/api/models").json()
        assert models == [
            {
                "ref": "local-openai/qwen3-coder",
                "provider": "local-openai",
                "model_id": "qwen3-coder",
                "display_name": "本地 Qwen3 Coder",
                "context_window": 131072,
            }
        ]

        settings_response = client.get("/api/settings/models")
        assert settings_response.status_code == 200
        assert settings_response.json() == [saved]
        assert "never-return-this-secret" not in settings_response.text

    secret = b"never-return-this-secret"
    assert all(
        secret not in path.read_bytes() for path in (tmp_path / "state").iterdir() if path.is_file()
    )


def test_saved_model_is_restored_after_application_restart(tmp_path: Path) -> None:
    """元数据与系统凭据都存在时，重启后模型应自动重新进入网关。"""
    state_dir = tmp_path / "state"
    credential_store = _MemoryCredentialStore()
    payload = {
        "provider": "deepseek",
        "modelId": "deepseek-chat",
        "displayName": "DeepSeek Chat",
        "protocol": "openai_completions",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "restart-secret",
        "contextWindow": 128000,
    }

    with TestClient(
        create_app(
            build_container(
                state_dir=state_dir,
                model_credential_store=credential_store,
            )
        )
    ) as client:
        assert client.post("/api/settings/models", json=payload).status_code == 201

    with TestClient(
        create_app(
            build_container(
                state_dir=state_dir,
                model_credential_store=credential_store,
            )
        )
    ) as reopened:
        models = reopened.get("/api/models").json()

    assert [model["ref"] for model in models] == ["deepseek/deepseek-chat"]


def test_saving_the_same_model_updates_its_configuration(tmp_path: Path) -> None:
    """用户输错密钥或名称后可以按同一模型引用覆盖修正，不产生重复配置。"""
    credential_store = _MemoryCredentialStore()
    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_credential_store=credential_store,
            )
        )
    ) as client:
        first = client.post(
            "/api/settings/models",
            json={
                "provider": "deepseek",
                "modelId": "deepseek-chat",
                "displayName": "旧名称",
                "protocol": "openai_completions",
                "baseUrl": "https://api.deepseek.com/v1",
                "apiKey": "wrong-key",
                "contextWindow": 128000,
            },
        ).json()
        updated_response = client.post(
            "/api/settings/models",
            json={
                "provider": "deepseek",
                "modelId": "deepseek-chat",
                "displayName": "DeepSeek Chat",
                "protocol": "openai_completions",
                "baseUrl": "https://api.deepseek.com/v1",
                "apiKey": "correct-key",
                "contextWindow": 128000,
            },
        )

        assert updated_response.status_code == 201
        updated = updated_response.json()
        assert updated["id"] == first["id"]
        assert updated["displayName"] == "DeepSeek Chat"
        assert len(client.get("/api/settings/models").json()) == 1
        assert credential_store.values[first["id"]] == "correct-key"


def test_failed_key_rotation_keeps_the_previous_model_available(tmp_path: Path) -> None:
    """系统凭据写入失败时必须回滚运行时，不能破坏原本可用的模型。"""
    credential_store = _MemoryCredentialStore()
    with TestClient(
        create_app(
            build_container(
                state_dir=tmp_path / "state",
                model_credential_store=credential_store,
            )
        )
    ) as client:
        initial = {
            "provider": "deepseek",
            "modelId": "deepseek-chat",
            "displayName": "原配置",
            "protocol": "openai_completions",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "valid-key",
            "contextWindow": 128000,
        }
        assert client.post("/api/settings/models", json=initial).status_code == 201

        credential_store.fail_set = True
        failed = client.post(
            "/api/settings/models",
            json={**initial, "displayName": "不应生效", "apiKey": "new-key"},
        )

        assert failed.status_code == 503
        models = client.get("/api/models").json()
        assert [(model["ref"], model["display_name"]) for model in models] == [
            ("deepseek/deepseek-chat", "原配置")
        ]


def test_credential_store_outage_does_not_prevent_application_startup(tmp_path: Path) -> None:
    """系统凭据保险库暂时不可用时，应用仍应启动并把设置错误暴露给用户。"""
    state_dir = tmp_path / "state"
    credential_store = _MemoryCredentialStore()
    with TestClient(
        create_app(
            build_container(
                state_dir=state_dir,
                model_credential_store=credential_store,
            )
        )
    ) as client:
        response = client.post(
            "/api/settings/models",
            json={
                "provider": "deepseek",
                "modelId": "deepseek-chat",
                "displayName": "DeepSeek Chat",
                "protocol": "openai_completions",
                "baseUrl": "https://api.deepseek.com/v1",
                "apiKey": "stored-key",
                "contextWindow": 128000,
            },
        )
        assert response.status_code == 201

    credential_store.fail_get = True
    with TestClient(
        create_app(
            build_container(
                state_dir=state_dir,
                model_credential_store=credential_store,
            )
        )
    ) as reopened:
        assert reopened.get("/api/health").status_code == 200
        assert reopened.get("/api/models").json() == []
        assert reopened.get("/api/settings/models").status_code == 503
