"""会话范围内的 Skill 目录与偏好接口。"""

from dataclasses import asdict
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from aime.application.projects.services import GetProject, ProjectNotFound
from aime.application.sessions.services import GetSession, SessionNotFound
from aime.application.skill_service import SkillService
from aime.domain.skills import SkillError


class SkillPreferenceRequest(BaseModel):
    """同时提交两个偏好字段，避免客户端以缺失值覆盖已有状态。"""

    ref: str = Field(min_length=1, max_length=1100, description="来源内唯一 Skill 引用")
    enabled: bool = Field(description="是否允许当前用户使用该 Skill")
    pinned: bool = Field(description="是否提高目录展示优先级；仍受预算限制")


def skill_router(
    service: SkillService, sessions: GetSession, projects: GetProject | None = None
) -> APIRouter:
    """身份和根目录来自服务端 Session，客户端不能提交任意文件路径。"""
    router = APIRouter(prefix="/api")

    async def roots(session_id: UUID) -> tuple[str, ...]:
        try:
            session = await sessions.execute(session_id)
            return session.workspace_roots or (session.workspace_path,)
        except SessionNotFound as exc:
            raise HTTPException(404, "会话不存在") from exc

    async def inventory_response(workspace_roots: tuple[str, ...]) -> dict[str, object]:
        inventory, diagnostics = await service.inventory(workspace_roots)
        sources = {
            str(Path(root) / ".agents" / "skills"): Path(root).name for root in workspace_roots
        }
        # 管理界面使用完整列表，模型调用只使用有界目录和搜索结果。
        return {
            "skills": [
                {
                    **{
                        key: value
                        for key, value in asdict(skill).items()
                        if key not in {"root", "path"}
                    },
                    "source": sources.get(skill.root, "个人"),
                    "scope": "workspace" if skill.root in sources else "user",
                }
                for skill in inventory
            ],
            "diagnostics": diagnostics,
        }

    @router.get("/skills")
    async def personal_catalog() -> dict[str, object]:
        # 未选择会话时只发现个人来源，不允许客户端指定任意工作区。
        return await inventory_response(())

    @router.get("/sessions/{session_id}/skills")
    async def catalog(session_id: UUID) -> dict[str, object]:
        return await inventory_response(await roots(session_id))

    async def project_roots(project_id: UUID) -> tuple[str, ...]:
        # 草稿没有 Session；只能通过已保存项目解析目录，拒绝任意路径扫描。
        if projects is None:
            raise HTTPException(404, "项目能力不可用")
        try:
            project = await projects.execute(project_id)
            return tuple(root.path for root in project.roots)
        except ProjectNotFound as exc:
            raise HTTPException(404, "项目不存在") from exc

    @router.get("/projects/{project_id}/skills")
    async def project_catalog(project_id: UUID) -> dict[str, object]:
        return await inventory_response(await project_roots(project_id))

    @router.put("/projects/{project_id}/skills/preference")
    async def project_preference(project_id: UUID, body: SkillPreferenceRequest) -> dict[str, bool]:
        try:
            await service.preference(
                await project_roots(project_id), body.ref, body.enabled, body.pinned
            )
        except SkillError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"saved": True}

    @router.put("/skills/preference")
    async def personal_preference(body: SkillPreferenceRequest) -> dict[str, bool]:
        try:
            await service.preference((), body.ref, body.enabled, body.pinned)
        except SkillError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"saved": True}

    @router.put("/sessions/{session_id}/skills/preference")
    async def preference(session_id: UUID, body: SkillPreferenceRequest) -> dict[str, bool]:
        try:
            await service.preference(await roots(session_id), body.ref, body.enabled, body.pinned)
        except SkillError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"saved": True}

    return router
