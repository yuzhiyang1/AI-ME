"""验证生产桌面端使用后端同源托管前端。"""

from pathlib import Path

from fastapi.testclient import TestClient

from aime.composition import build_container
from aime.main import create_app


def test_production_frontend_is_served_from_app_path(tmp_path: Path) -> None:
    """构建产物存在时，/app/ 必须返回前端入口并与 API 保持同源。"""
    frontend_dist = tmp_path / "dist"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text(
        "<!doctype html><title>AI-ME production</title>",
        encoding="utf-8",
    )

    app = create_app(
        build_container(state_dir=tmp_path / "state"),
        frontend_dist=frontend_dist,
    )
    with TestClient(app) as client:
        frontend = client.get("/app/")
        health = client.get("/api/health")

    assert frontend.status_code == 200
    assert "AI-ME production" in frontend.text
    assert health.status_code == 200
