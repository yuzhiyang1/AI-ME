"""通过公开 HTTP 接口验证本地 Project 纵向切片。"""

from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from aime.composition import build_container
from aime.main import create_app


def _project_payload(first: Path, second: Path, *, key: str = "project-create-1") -> dict:
    """构造保留目录顺序的项目创建请求。"""
    return {
        "name": "  AI-ME  ",
        "roots": [{"path": str(first)}, {"path": str(second)}],
        "idempotencyKey": key,
    }


def test_project_create_persists_ordered_roots_and_is_idempotent(tmp_path: Path) -> None:
    """重复提交同一创建请求时返回同一个项目，且第一个目录始终是主目录。"""
    first_root = tmp_path / "primary"
    second_root = tmp_path / "secondary"
    first_root.mkdir()
    second_root.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        payload = _project_payload(first_root, second_root)
        first = client.post("/api/projects", json=payload)
        repeated = client.post("/api/projects", json=payload)
        listed = client.get("/api/projects")

    assert first.status_code == 201
    assert repeated.status_code == 201
    assert repeated.json() == first.json()
    assert listed.json() == [first.json()]
    assert first.json()["name"] == "AI-ME"
    assert first.json()["roots"] == [
        {"path": str(first_root.resolve()), "position": 0, "primary": True},
        {"path": str(second_root.resolve()), "position": 1, "primary": False},
    ]


def test_project_can_be_updated_and_deleted_without_leaving_a_readable_project(
    tmp_path: Path,
) -> None:
    """项目编辑替换完整目录顺序，删除后读取稳定返回 404。"""
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    primary.mkdir()
    secondary.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        created = client.post(
            "/api/projects",
            json=_project_payload(primary, secondary),
        ).json()
        updated = client.patch(
            f"/api/projects/{created['id']}",
            json={
                "name": "重新命名",
                "roots": [{"path": str(secondary)}, {"path": str(primary)}],
            },
        )
        deleted = client.delete(f"/api/projects/{created['id']}")
        missing = client.get(f"/api/projects/{created['id']}")

    assert updated.status_code == 200
    assert updated.json()["name"] == "重新命名"
    assert updated.json()["roots"][0]["path"] == str(secondary.resolve())
    assert updated.json()["roots"][0]["primary"] is True
    assert deleted.status_code == 204
    assert missing.status_code == 404


def test_project_rejects_invalid_roots_and_idempotency_conflicts(tmp_path: Path) -> None:
    """目录不合法、重复以及幂等键绑定不同请求时不产生脏项目。"""
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    file_path = tmp_path / "not-a-directory.txt"
    primary.mkdir()
    secondary.mkdir()
    file_path.write_text("not a directory", encoding="utf-8")

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        empty_roots = client.post(
            "/api/projects",
            json={"name": "empty", "roots": [], "idempotencyKey": "empty-roots"},
        )
        duplicate = client.post(
            "/api/projects",
            json={
                "name": "duplicate",
                "roots": [{"path": str(primary)}, {"path": str(primary)}],
                "idempotencyKey": "duplicate-roots",
            },
        )
        not_directory = client.post(
            "/api/projects",
            json={
                "name": "file",
                "roots": [{"path": str(file_path)}],
                "idempotencyKey": "file-root",
            },
        )
        client.post(
            "/api/projects",
            json=_project_payload(primary, secondary, key="fixed-key"),
        )
        conflict = client.post(
            "/api/projects",
            json={
                "name": "different",
                "roots": [{"path": str(primary)}],
                "idempotencyKey": "fixed-key",
            },
        )

    assert empty_roots.status_code == 422
    assert duplicate.status_code == 422
    assert "重复目录" in duplicate.json()["detail"]
    assert not_directory.status_code == 422
    assert "不是文件夹" in not_directory.json()["detail"]
    assert conflict.status_code == 409


def test_unknown_project_operations_return_not_found(tmp_path: Path) -> None:
    """读取、编辑和删除未知项目都保持一致的 404 语义。"""
    project_id = uuid4()
    root = tmp_path / "root"
    root.mkdir()

    with TestClient(create_app(build_container(state_dir=tmp_path / "state"))) as client:
        fetched = client.get(f"/api/projects/{project_id}")
        updated = client.patch(
            f"/api/projects/{project_id}",
            json={"name": "missing", "roots": [{"path": str(root)}]},
        )
        deleted = client.delete(f"/api/projects/{project_id}")

    assert fetched.status_code == 404
    assert updated.status_code == 404
    assert deleted.status_code == 404
