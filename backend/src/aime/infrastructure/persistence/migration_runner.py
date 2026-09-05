"""以程序化方式执行本地 SQLite 的 Alembic 迁移。"""

import sqlite3
from pathlib import Path

from alembic import command
from alembic.config import Config

_PREVIEW_BASE_REVISION = "0001_agent_sessions"
_APP_TABLES = {
    "agent_sessions",
    "agent_turns",
    "agent_runs",
    "runtime_events",
    "session_items",
}
_EXPECTED_COLUMNS: dict[str, dict[str, tuple[str, int | None]]] = {
    "agent_sessions": {
        "id": ("VARCHAR(36)", 1),
        "title": ("VARCHAR(120)", 1),
        "workspace_path": ("VARCHAR", 1),
        "default_model": ("VARCHAR(200)", 1),
        "permission_profile": ("VARCHAR(32)", 1),
        "lifecycle": ("VARCHAR(32)", 1),
        "activity": ("VARCHAR(32)", 1),
        "pinned": ("BOOLEAN", 1),
        "created_at": ("DATETIME", 1),
        "updated_at": ("DATETIME", 1),
        "last_event_sequence": ("INTEGER", 1),
    },
    "agent_turns": {
        "id": ("VARCHAR(36)", 1),
        "session_id": ("VARCHAR(36)", 1),
        "status": ("VARCHAR(32)", 1),
        "client_request_id": ("VARCHAR(120)", 1),
        "created_at": ("DATETIME", 1),
        "started_at": ("DATETIME", 0),
        "finished_at": ("DATETIME", 0),
    },
    "agent_runs": {
        "id": ("VARCHAR(36)", 1),
        "session_id": ("VARCHAR(36)", 1),
        "turn_id": ("VARCHAR(36)", 1),
        "attempt": ("INTEGER", 1),
        "status": ("VARCHAR(32)", 1),
        "model_ref": ("VARCHAR(200)", 1),
        # 早期 create_all 预览库是非空，0002 会统一升级为可空。
        "started_at": ("DATETIME", None),
        "finished_at": ("DATETIME", 0),
        "terminal_event_id": ("VARCHAR(36)", 0),
    },
    "runtime_events": {
        "id": ("VARCHAR(36)", 1),
        "session_id": ("VARCHAR(36)", 1),
        "turn_id": ("VARCHAR(36)", 1),
        "run_id": ("VARCHAR(36)", 0),
        "sequence": ("INTEGER", 1),
        "type": ("VARCHAR(64)", 1),
        "payload_json": ("TEXT", 1),
        "created_at": ("DATETIME", 1),
    },
    "session_items": {
        "id": ("VARCHAR(36)", 1),
        "session_id": ("VARCHAR(36)", 1),
        "turn_id": ("VARCHAR(36)", 1),
        "run_id": ("VARCHAR(36)", 0),
        "sequence": ("INTEGER", 1),
        "type": ("VARCHAR(64)", 1),
        "status": ("VARCHAR(32)", 1),
        "content_json": ("TEXT", 1),
        "created_at": ("DATETIME", 1),
    },
}
_REQUIRED_UNIQUE_COLUMNS = {
    "agent_turns": {("session_id", "client_request_id")},
    "agent_runs": {("turn_id", "attempt")},
    "runtime_events": {("session_id", "sequence")},
    "session_items": {("session_id", "sequence")},
}
_REQUIRED_FOREIGN_KEYS = {
    "agent_turns": {("session_id", "agent_sessions", "id", "CASCADE")},
    "agent_runs": {
        ("session_id", "agent_sessions", "id", "CASCADE"),
        ("turn_id", "agent_turns", "id", "CASCADE"),
    },
    "runtime_events": {
        ("session_id", "agent_sessions", "id", "CASCADE"),
        ("turn_id", "agent_turns", "id", "CASCADE"),
        ("run_id", "agent_runs", "id", "CASCADE"),
    },
    "session_items": {
        ("session_id", "agent_sessions", "id", "CASCADE"),
        ("turn_id", "agent_turns", "id", "CASCADE"),
        ("run_id", "agent_runs", "id", "CASCADE"),
    },
}


def upgrade_database(database_path: Path) -> None:
    """把状态库升级到 head，并兼容尚未版本化的早期本地预览库。"""
    config = _alembic_config(database_path)
    if _is_unversioned_preview_database(database_path):
        _adopt_preview_database(database_path, config)
        return
    command.upgrade(config, "head")


def _alembic_config(database_path: Path) -> Config:
    """构造不依赖当前工作目录的 Alembic 配置。"""
    config = Config()
    migrations = Path(__file__).with_name("migrations")
    config.set_main_option("script_location", str(migrations))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    return config


def _is_unversioned_preview_database(database_path: Path) -> bool:
    """识别此前 create_all 生成、但没有 Alembic 版本号的预览数据库。"""
    if not database_path.exists():
        return False
    with sqlite3.connect(database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    return "alembic_version" not in tables and bool(tables & _APP_TABLES)


def _adopt_preview_database(database_path: Path, config: Config) -> None:
    """校验早期结构后纳入版本管理；不接受半残或未知结构。"""
    with sqlite3.connect(database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        missing = _APP_TABLES - tables
        if missing:
            missing_names = ", ".join(sorted(missing))
            raise RuntimeError(f"未版本化状态库结构不完整，缺少：{missing_names}")
        _validate_columns(connection)
        _validate_unique_constraints(connection)
        _validate_foreign_keys(connection)
        _validate_existing_rows(connection)
        _ensure_active_turn_index(connection)
    command.stamp(config, _PREVIEW_BASE_REVISION)
    command.upgrade(config, "head")


def _validate_columns(connection: sqlite3.Connection) -> None:
    """精确校验预览库的完整列集合、SQLite 类型与可空性。"""
    for table_name, expected_columns in _EXPECTED_COLUMNS.items():
        rows = connection.execute(f"PRAGMA table_info('{table_name}')").fetchall()
        actual_columns = {str(row[1]): row for row in rows}
        if actual_columns.keys() != expected_columns.keys():
            missing = sorted(expected_columns.keys() - actual_columns.keys())
            unexpected = sorted(actual_columns.keys() - expected_columns.keys())
            raise RuntimeError(
                f"未版本化状态库表 {table_name} 字段不匹配；"
                f"缺少={missing}，多出={unexpected}"
            )
        for column_name, (expected_type, expected_not_null) in expected_columns.items():
            row = actual_columns[column_name]
            actual_type = str(row[2]).upper()
            actual_not_null = int(row[3])
            if actual_type != expected_type or (
                expected_not_null is not None and actual_not_null != expected_not_null
            ):
                raise RuntimeError(
                    f"未版本化状态库表 {table_name}.{column_name} 定义不匹配；"
                    f"实际=({actual_type}, notnull={actual_not_null})，"
                    f"预期=({expected_type}, notnull={expected_not_null})"
                )


def _validate_unique_constraints(connection: sqlite3.Connection) -> None:
    """确认幂等键与事件序列等关键唯一约束没有在预览库中丢失。"""
    for table_name, required_columns in _REQUIRED_UNIQUE_COLUMNS.items():
        unique_columns: set[tuple[str, ...]] = set()
        for index_row in connection.execute(f"PRAGMA index_list('{table_name}')").fetchall():
            if not index_row[2]:
                continue
            index_name = str(index_row[1]).replace("'", "''")
            columns = tuple(
                str(row[2])
                for row in connection.execute(f"PRAGMA index_info('{index_name}')").fetchall()
            )
            unique_columns.add(columns)
        missing = required_columns - unique_columns
        if missing:
            raise RuntimeError(f"未版本化状态库表 {table_name} 缺少关键唯一约束：{missing}")


def _validate_foreign_keys(connection: sqlite3.Connection) -> None:
    """确认聚合账本各表仍保持预期级联外键。"""
    for table_name, required_foreign_keys in _REQUIRED_FOREIGN_KEYS.items():
        actual = {
            (str(row[3]), str(row[2]), str(row[4]), str(row[6]).upper())
            for row in connection.execute(f"PRAGMA foreign_key_list('{table_name}')").fetchall()
        }
        missing = required_foreign_keys - actual
        if missing:
            raise RuntimeError(f"未版本化状态库表 {table_name} 缺少关键外键：{missing}")


def _validate_existing_rows(connection: sqlite3.Connection) -> None:
    """即使旧连接曾关闭外键，也拒绝收编已经含孤儿记录的数据库。"""
    violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError(f"未版本化状态库存在外键违规数据：{violations[:5]}")


def _ensure_active_turn_index(connection: sqlite3.Connection) -> None:
    """补建缺失索引，但拒绝同名、非唯一或谓词错误的可疑索引。"""
    index_row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' "
        "AND name = 'uq_active_turn_per_session'"
    ).fetchone()
    if index_row is None:
        connection.execute(
            "CREATE UNIQUE INDEX uq_active_turn_per_session "
            "ON agent_turns (session_id) "
            "WHERE status IN ('queued', 'in_progress', 'waiting_for_user')"
        )
        return

    index_info = next(
        (
            row
            for row in connection.execute("PRAGMA index_list('agent_turns')").fetchall()
            if row[1] == "uq_active_turn_per_session"
        ),
        None,
    )
    columns = tuple(
        str(row[2])
        for row in connection.execute(
            "PRAGMA index_info('uq_active_turn_per_session')"
        ).fetchall()
    )
    sql = str(index_row[0] or "").upper()
    required_fragments = ("WHERE", "QUEUED", "IN_PROGRESS", "WAITING_FOR_USER")
    if (
        index_info is None
        or int(index_info[2]) != 1
        or int(index_info[4]) != 1
        or columns != ("session_id",)
        or any(fragment not in sql for fragment in required_fragments)
    ):
        raise RuntimeError("未版本化状态库的活跃 Turn 唯一索引定义不匹配")
