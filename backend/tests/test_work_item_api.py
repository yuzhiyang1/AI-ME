"""通过公开 HTTP 接口验证第一个纵向切片。"""

from fastapi.testclient import TestClient

from aime.main import create_app


def test_user_can_create_and_list_work_items() -> None:
    with TestClient(create_app()) as client:
        created = client.post("/api/work-items", json={"title": "排查支付接口告警"})
        listed = client.get("/api/work-items")

    assert created.status_code == 201
    assert created.json()["status"] == "pending"
    assert listed.status_code == 200
    assert [item["title"] for item in listed.json()] == ["排查支付接口告警"]


def test_health_endpoint_reports_service_identity() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai-me"}

