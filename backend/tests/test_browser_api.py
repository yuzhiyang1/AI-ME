"""真实 ASGI HTTP/WebSocket 的鉴权、设置持久化与审批联动。"""

import json
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_browser_service import Credentials, Planner, TextGateway

from aime.composition import build_container
from aime.main import create_app

TOKEN = "a" * 64
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def make_app(tmp_path, monkeypatch, token=TOKEN):
    monkeypatch.setenv("AIME_BROWSER_BRIDGE_TOKEN", token)
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    return create_app(build_container(
        state_dir=tmp_path / "state", model_credential_store=Credentials(),
        model_gateway=TextGateway(), browser_planner=Planner(),
    ))


@pytest.mark.parametrize("token", ["", "short", "z" * 64])
def test_browser_disabled_without_valid_launcher_secret(tmp_path, monkeypatch, token):
    with TestClient(make_app(tmp_path, monkeypatch, token)) as client:
        assert client.get("/api/browser/config", headers=HEADERS).status_code == 503
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/browser/bridge", headers=HEADERS):
                pass


def test_http_and_ws_require_token_and_reject_all_origins(tmp_path, monkeypatch):
    with TestClient(make_app(tmp_path, monkeypatch)) as client:
        assert client.get("/api/browser/config").status_code == 401
        for origin in ("https://evil.test", "http://localhost:5173", "null"):
            headers = {**HEADERS, "Origin": origin}
            assert client.get("/api/browser/config", headers=headers).status_code == 403
            assert client.options("/api/browser/config", headers=headers).status_code == 403
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect("/api/browser/bridge", headers=headers):
                    pass
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/browser/bridge", subprotocols=[
                "aime-browser", "token." + "b" * 64,
            ]):
                pass
        with client.websocket_connect("/api/browser/bridge", subprotocols=[
            "aime-browser", f"token.{TOKEN}",
        ]) as websocket:
            assert websocket.accepted_subprotocol == "aime-browser"
            assert client.get("/api/browser/config", headers=HEADERS).json()["bridgeConnected"]
            with client.websocket_connect("/api/browser/bridge", headers=HEADERS) as duplicate:
                with pytest.raises(WebSocketDisconnect):
                    duplicate.receive_json()
            assert client.get("/api/browser/config", headers=HEADERS).json()["bridgeConnected"]


def test_settings_never_echo_key_even_in_invalid_body(tmp_path, monkeypatch):
    with TestClient(make_app(tmp_path, monkeypatch)) as client:
        payload = {"apiKey": "secret-for-test", "model": "jev-setting"}
        saved = client.post("/api/browser/config", headers=HEADERS, json=payload)
        assert saved.status_code == 200
        assert saved.json() == {"configured": True, "model": "jev-setting",
                                "textConfigured": True, "bridgeConnected": False}
        assert "secret-for-test" not in saved.text
        invalid = client.post("/api/browser/config", headers=HEADERS, json={**payload, "model": []})
        assert invalid.status_code == 422 and "secret-for-test" not in invalid.text
        assert client.post("/api/browser/config", headers=HEADERS,
                           json={**payload, "clearApiKey": True}).status_code == 422
        missing = client.post(f"/api/browser/sessions/{uuid4()}/runs", headers=HEADERS,
                              json={"goal": "Search"})
        assert missing.status_code == 404


def test_http_ws_approval_done_and_saved_run(tmp_path, monkeypatch):
    with TestClient(make_app(tmp_path, monkeypatch)) as client:
        client.post("/api/browser/config", headers=HEADERS,
                    json={"apiKey": "fake", "model": "jev-test"}).raise_for_status()
        session = client.post("/api/sessions", json={
            "workspacePath": str(tmp_path), "defaultModel": "test/text",
            "permissionProfile": "read_only",
        })
        assert session.status_code == 201, session.text
        session_id = session.json()["id"]
        prefix = f"/api/browser/sessions/{session_id}/runs"
        assert client.get(prefix + "/current", headers=HEADERS).json() is None
        with client.websocket_connect("/api/browser/bridge", headers=HEADERS) as websocket:
            created = client.post(prefix, headers=HEADERS, json={"goal": "Search", "maxSteps": 1})
            assert created.status_code == 201, created.text
            run = created.json()
            observe = websocket.receive_json()
            assert observe["arguments"]["runId"] == run["id"]
            websocket.send_json({"id": observe["id"], "result": {
                "snapshotId": "snap", "url": "https://fixture.test", "title": "Search", "text": "",
                "actions": [{"id": "search", "kind": "click", "label": "Search"}],
            }})
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = client.get(prefix + "/current", headers=HEADERS).json()
                if current["status"] == "awaiting_approval":
                    break
                time.sleep(0.005)
            else:
                pytest.fail("没有进入审批状态")
            pending = current["pendingAction"]
            duplicate = client.post(prefix, headers=HEADERS, json={"goal": "duplicate"})
            assert duplicate.status_code == 409
            assert client.post("/api/browser/config", headers=HEADERS,
                               json={"model": "changed"}).status_code == 409
            assert client.post(prefix + f"/{run['id']}/approve", headers=HEADERS,
                               json={"approve": True}).status_code == 422
            approved = client.post(prefix + f"/{run['id']}/approve", headers=HEADERS,
                                   json={"approve": True, "approvalId": pending["approvalId"]})
            assert approved.status_code == 200
            assert approved.json()["status"] == "running"
            act = websocket.receive_json()
            assert act["operation"] == "act"
            assert act["arguments"] == {
                "snapshotId": "snap", "actionId": "search", "runId": run["id"],
            }
            websocket.send_json({"id": act["id"], "result": {"ok": True}})
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = client.get(prefix + "/current", headers=HEADERS).json()
                if current["status"] == "blocked":
                    break
                time.sleep(0.005)
            assert current["steps"][0]["status"] == "executed"
            assert "fake" not in json.dumps(current)


def test_invalid_ws_frame_closes_connection(tmp_path, monkeypatch):
    with TestClient(make_app(tmp_path, monkeypatch)) as client:
        with client.websocket_connect("/api/browser/bridge", headers=HEADERS) as websocket:
            websocket.send_text('{"id":"bad/id", "result":{}}')
            with pytest.raises(WebSocketDisconnect):
                websocket.receive_json()
