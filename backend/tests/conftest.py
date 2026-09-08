"""后端测试的共享安全边界。"""

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_default_application_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """禁止使用默认容器的测试写入用户真实的本地状态目录。"""
    monkeypatch.setenv("AIME_STATE_DIR", str(tmp_path / "default-state"))
