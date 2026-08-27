"""开发诊断模型接口的输入边界测试。"""

from fastapi.testclient import TestClient

from aime.main import create_app


def test_generic_chat_route_is_not_exposed() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/chat/completions",
            json={"model": "missing/model", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert response.status_code == 404


def test_diagnostic_completion_requires_messages() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/dev/chat/completions",
            json={"model": "missing/model", "messages": []},
        )

    assert response.status_code == 422


def test_system_prompt_has_only_one_input_location() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/dev/chat/completions",
            json={
                "model": "missing/model",
                "messages": [{"role": "system", "content": "重复来源"}],
                "system": "唯一系统提示词",
            },
        )

    assert response.status_code == 422


def test_unknown_model_is_rejected_before_streaming() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/dev/chat/completions",
            json={"model": "missing/model", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "未知模型引用：missing/model"
