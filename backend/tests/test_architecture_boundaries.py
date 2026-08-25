"""用自动化测试锁定洋葱架构的依赖方向。"""

import ast
from pathlib import Path

SOURCE_ROOT = Path(__file__).parents[1] / "src" / "aime"


def _imports_under(path: Path) -> set[str]:
    imports: set[str] = set()
    for source_file in path.rglob("*.py"):
        tree = ast.parse(source_file.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
    return imports


def test_domain_has_no_outer_layer_or_framework_dependencies() -> None:
    imports = _imports_under(SOURCE_ROOT / "domain")
    forbidden = (
        "aime.application",
        "aime.infrastructure",
        "aime.presentation",
        "fastapi",
        "pydantic",
        "sqlalchemy",
    )

    violations = sorted(name for name in imports if name.startswith(forbidden))
    assert violations == []


def test_application_does_not_depend_on_delivery_or_infrastructure() -> None:
    imports = _imports_under(SOURCE_ROOT / "application")
    forbidden = ("aime.infrastructure", "aime.presentation", "fastapi", "sqlalchemy")

    violations = sorted(name for name in imports if name.startswith(forbidden))
    assert violations == []

