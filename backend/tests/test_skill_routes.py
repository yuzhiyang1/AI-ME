"""列表接口不接受任意目录；无会话时只暴露个人来源。"""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from aime.application.projects.services import ProjectNotFound
from aime.domain.skills import SkillError
from aime.presentation.api.skill_routes import skill_router


def test_personal_inventory_and_preference_do_not_use_workspace():
    service = SimpleNamespace(inventory=AsyncMock(return_value=([], [])), preference=AsyncMock())
    sessions = SimpleNamespace(execute=AsyncMock())
    app = FastAPI()
    app.include_router(skill_router(service, sessions))
    with TestClient(app) as client:
        assert client.get("/api/skills").json() == {"skills": [], "diagnostics": []}
        service.inventory.assert_awaited_once_with(())
        service.preference.side_effect = SkillError("skill_not_found")
        response = client.put(
            "/api/skills/preference",
            json={
                "ref": "project:private",
                "enabled": True,
                "pinned": False,
            },
        )
        assert response.status_code == 422
        service.preference.assert_awaited_once_with((), "project:private", True, False)
        sessions.execute.assert_not_awaited()


def test_session_inventory_uses_server_session_roots():
    service = SimpleNamespace(inventory=AsyncMock(return_value=([], [])))
    sessions = SimpleNamespace(
        execute=AsyncMock(
            return_value=SimpleNamespace(
                workspace_roots=("trusted-workspace",),
                workspace_path="trusted-workspace",
            )
        )
    )
    app = FastAPI()
    app.include_router(skill_router(service, sessions))
    with TestClient(app) as client:
        assert client.get(f"/api/sessions/{uuid4()}/skills").status_code == 200
        service.inventory.assert_awaited_once_with(("trusted-workspace",))


def test_project_inventory_and_preference_resolve_authoritative_roots():
    """草稿可发现多根项目技能，但客户端不能用路径绕过项目授权。"""
    service = SimpleNamespace(inventory=AsyncMock(return_value=([], [])), preference=AsyncMock())
    projects = SimpleNamespace(
        execute=AsyncMock(
            return_value=SimpleNamespace(
                roots=(SimpleNamespace(path="trusted-main"), SimpleNamespace(path="trusted-extra")),
            )
        )
    )
    app = FastAPI()
    app.include_router(skill_router(service, SimpleNamespace(execute=AsyncMock()), projects))
    project_id = uuid4()
    with TestClient(app) as client:
        assert (
            client.get(f"/api/projects/{project_id}/skills?workspacePath=private").status_code
            == 200
        )
        service.inventory.assert_awaited_once_with(("trusted-main", "trusted-extra"))
        assert (
            client.put(
                f"/api/projects/{project_id}/skills/preference",
                json={
                    "ref": "project:review",
                    "enabled": False,
                    "pinned": True,
                },
            ).status_code
            == 200
        )
        service.preference.assert_awaited_once_with(
            ("trusted-main", "trusted-extra"), "project:review", False, True
        )
        projects.execute.side_effect = ProjectNotFound()
        assert client.get(f"/api/projects/{project_id}/skills").status_code == 404
        assert client.get("/api/projects/not-a-uuid/skills").status_code == 422
