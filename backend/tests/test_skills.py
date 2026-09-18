"""真实文件和 SQLite 验证 Skill 的权限、版本、规模及请求接入。"""

import json
from dataclasses import replace
from pathlib import Path
from urllib.parse import quote

import pytest

from aime.application.skill_service import SkillRun, SkillService
from aime.domain.skills import SkillError, text_cost
from aime.infrastructure.persistence.sqlite_database import SqliteDatabase
from aime.infrastructure.persistence.sqlite_skill_store import SqliteSkillStore
from aime.infrastructure.skills import LocalSkillResources


def make_skill(
    root: Path, name: str = "review", body: str = "检查除数为零。", extra: str = ""
) -> Path:
    """写入最小真实 Skill，测试不依赖用户个人目录。"""
    path = root / ".agents" / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: 检查代码及测试边界\n{extra}---\n{body}", encoding="utf-8"
    )
    return path


@pytest.fixture
async def skills_env(tmp_path: Path):
    database = SqliteDatabase(tmp_path / "state")
    await database.initialize()
    service = SkillService(LocalSkillResources(()), SqliteSkillStore(database.session_factory))
    yield service, tmp_path
    await database.close()


async def test_discovery_shadowing_invalid_and_personal(tmp_path: Path):
    project = make_skill(tmp_path)
    personal = tmp_path / "personal"
    make_skill(personal)
    invalid = project.parent.parent / "bad" / "SKILL.md"
    invalid.parent.mkdir()
    invalid.write_text("---\nname: bad\n---\n缺失描述", encoding="utf-8")
    service = LocalSkillResources((personal / ".agents/skills",))
    skills, errors = await service.discover((str(tmp_path),))
    assert len(skills) == 2
    assert skills[0].shadowed is False and skills[1].shadowed is True
    assert skills[0].ref != skills[1].ref
    assert len(errors) == 1 and "description" in errors[0]


async def test_thousand_skills_catalog_bounded_and_long_tail_search(skills_env):
    service, root = skills_env
    make_skill(root)
    original = (await service.inventory((str(root),)))[0][0]
    skills = [
        replace(
            original,
            ref=f"root:{i}",
            name=f"skill-{i}",
            description="普通工具" if i != 999 else "音频转写与会议纪要",
        )
        for i in range(1000)
    ]
    run = SkillRun(service, skills, "s", "r", [], [])
    catalog = run.catalog(128_000)
    assert 0 < text_cost(catalog) <= 2560
    assert "root:999" not in catalog
    result = await run.search("会议")
    assert result["matches"][0]["ref"] == "root:999"
    assert len(result["matches"]) <= 8
    assert "content" not in result["matches"][0]
    assert (await run.search("root:999"))["matches"][0]["ref"] == "root:999"


async def test_search_pagination_and_query_bound_cursor(skills_env):
    service, root = skills_env
    make_skill(root)
    original = (await service.inventory((str(root),)))[0][0]
    run = SkillRun(service, [replace(original, ref=f"r:{i}") for i in range(20)], "s", "r", [], [])
    first = await run.search("检查")
    second = await run.search("检查", first["next_cursor"])
    assert set(x["ref"] for x in first["matches"]).isdisjoint(x["ref"] for x in second["matches"])
    with pytest.raises(SkillError, match="invalid_cursor"):
        await run.search("测试", first["next_cursor"])


async def test_body_pages_survive_source_edit_and_run_restart(skills_env):
    service, root = skills_env
    file = make_skill(root, body="中文内容" * 1500)
    run = await service.start((str(root),), "s", "r", "检查代码")
    ref = run.skills[0].ref
    first = await run.read(ref)
    assert not first["complete"]
    file.write_text("changed", encoding="utf-8")
    restored = await service.start((str(root),), "s", "r", "检查代码")
    content = first["content"]
    page = first
    while page["next_cursor"]:
        page = await restored.read(ref, cursor=page["next_cursor"])
        content += page["content"]
    assert content.endswith("中文内容" * 1500)
    assert page["complete"]
    other = make_skill(root, "other")
    new_run = await service.start((str(root),), "s", "new", "检查")
    other.write_text("changed", encoding="utf-8")
    with pytest.raises(SkillError, match="skill_version_changed"):
        await new_run.read(new_run.skills[0].ref)


@pytest.mark.parametrize("resource", ["../secret", "C:/secret", "/secret", "refs/../../secret"])
async def test_resource_escape_rejected(skills_env, resource):
    service, root = skills_env
    make_skill(root)
    run = await service.start((str(root),), "s", "r", "检查")
    with pytest.raises((SkillError, OSError)):
        await run.read(run.skills[0].ref, resource)


async def test_disabled_and_explicit_only_never_autoload(skills_env):
    service, root = skills_env
    make_skill(root, extra="disable-model-invocation: true\n")
    run = await service.start((str(root),), "s", "r", "检查")
    assert run.catalog(128000) == ""
    assert not (await run.search("检查"))["matches"]
    with pytest.raises(SkillError, match="explicit_only"):
        await run.read(run.skills[0].ref)
    explicit = await service.start((str(root),), "s", "explicit", "/skill:review 检查")
    assert "检查除数为零" in await explicit.explicit_content()
    await service.preference((str(root),), run.skills[0].ref, False, True)
    with pytest.raises(SkillError, match="disabled"):
        await explicit.read(run.skills[0].ref)
    with pytest.raises(SkillError, match="not_available"):
        await service.start((str(root),), "s", "new", "/skill:review")


async def test_cursor_cannot_cross_skill_or_session(skills_env):
    service, root = skills_env
    make_skill(root, body="x" * 25000)
    run = await service.start((str(root),), "a", "r", "检查")
    page = await run.read(run.skills[0].ref)
    other = await service.start((str(root),), "b", "r", "检查")
    with pytest.raises(SkillError, match="invalid_cursor"):
        await other.read(other.skills[0].ref, cursor=page["next_cursor"])


async def test_attachment_is_readable_but_not_a_new_tool(skills_env):
    service, root = skills_env
    file = make_skill(root)
    (file.parent / "reference.txt").write_text("附件内容", encoding="utf-8")
    run = await service.start((str(root),), "s", "r", "检查")
    result = await run.read(run.skills[0].ref, "reference.txt")
    assert result["content"] == "附件内容"
    assert result["complete"] is True
    with pytest.raises(SkillError, match="not_found"):
        await run.read("outside:ref")


async def test_preferences_are_persisted(skills_env):
    service, root = skills_env
    make_skill(root)
    skills, _ = await service.inventory((str(root),))
    await service.preference((str(root),), skills[0].ref, False, True)
    saved, _ = await service.inventory((str(root),))
    assert not saved[0].enabled and saved[0].pinned
    assert json.loads(await service.store.get("pref:" + saved[0].ref))["pinned"]


async def test_ui_encoded_reference_preserves_spaces_and_percent(skills_env):
    service, root = skills_env
    make_skill(root, name="my review%20")
    skills, _ = await service.inventory((str(root),))
    ref = skills[0].ref
    run = await service.start((str(root),), "s", "encoded", f"/skill:{quote(ref, safe='')} 检查")
    assert run.explicit == [ref]
    assert "检查除数为零" in await run.explicit_content()


async def test_resource_too_large_for_page_budget_fails_before_partial_read(skills_env):
    service, root = skills_env
    make_skill(root, body="x" * 60000)
    run = await service.start((str(root),), "s", "small-model", "检查")
    run.page_bytes = 1400
    with pytest.raises(SkillError, match="skill_read_budget_exceeded"):
        await run.read(run.skills[0].ref)
    assert not await run.handoff()
