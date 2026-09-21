"""Project 应用服务。"""

import hashlib
import json
import os
from pathlib import Path
from uuid import UUID

from anyio import to_thread

from aime.application.projects.commands import CreateProjectCommand, UpdateProjectCommand
from aime.domain.projects.entities import Project
from aime.domain.projects.repositories import ProjectRepository


class ProjectNotFound(LookupError):
    """请求的 Project 不存在。"""


class CreateProject:
    """规范化本地目录并幂等创建 Project。"""

    def __init__(self, repository: ProjectRepository) -> None:
        self._repository = repository

    async def execute(self, command: CreateProjectCommand) -> Project:
        """校验完整输入，并返回新建或幂等复用的 Project。"""
        name = _normalize_name(command.name)
        roots = await to_thread.run_sync(_normalize_roots, command.roots)
        key = command.idempotency_key.strip()
        if not key or len(key) > 120:
            raise ValueError("项目创建幂等键不能为空且最长 120 个字符")
        projects = await self._repository.list_all()
        position = max((project.position for project in projects), default=-1) + 1
        project = Project.create(name=name, roots=roots, position=position)
        result = await self._repository.create(
            project,
            idempotency_key=key,
            request_hash=_request_hash(name, roots),
        )
        return result.project


class ListProjects:
    """按固定侧栏顺序读取全部 Project。"""

    def __init__(self, repository: ProjectRepository) -> None:
        self._repository = repository

    async def execute(self) -> list[Project]:
        return await self._repository.list_all()


class GetProject:
    """读取一条 Project。"""

    def __init__(self, repository: ProjectRepository) -> None:
        self._repository = repository

    async def execute(self, project_id: UUID) -> Project:
        project = await self._repository.get(project_id)
        if project is None:
            raise ProjectNotFound("项目不存在或已删除")
        return project


class UpdateProject:
    """原子替换 Project 的名称与目录模板。"""

    def __init__(self, repository: ProjectRepository) -> None:
        self._repository = repository

    async def execute(self, command: UpdateProjectCommand) -> Project:
        project = await self._repository.get(command.project_id)
        if project is None:
            raise ProjectNotFound("项目不存在或已删除")
        roots = await to_thread.run_sync(_normalize_roots, command.roots)
        project.update(name=_normalize_name(command.name), roots=roots)
        if not await self._repository.update(project):
            raise ProjectNotFound("项目不存在或已删除")
        return project


class DeleteProject:
    """删除 Project 配置；数据库负责保留并解绑已有会话。"""

    def __init__(self, repository: ProjectRepository) -> None:
        self._repository = repository

    async def execute(self, project_id: UUID) -> None:
        if not await self._repository.delete(project_id):
            raise ProjectNotFound("项目不存在或已删除")


def _normalize_name(name: str) -> str:
    """清理名称并在进入领域对象前给出稳定错误。"""
    normalized = name.strip()
    if not normalized or len(normalized) > 120:
        raise ValueError("项目名称不能为空且最长 120 个字符")
    return normalized


def _normalize_roots(raw_roots: tuple[str, ...]) -> tuple[str, ...]:
    """解析真实目录并以平台路径语义拒绝重复项。"""
    if not raw_roots:
        raise ValueError("项目至少需要一个目录")
    normalized: list[str] = []
    path_keys: set[str] = set()
    for raw_path in raw_roots:
        try:
            resolved = Path(raw_path).expanduser().resolve(strict=True)
        except (FileNotFoundError, OSError) as exc:
            raise ValueError(f"项目目录不存在或无法访问：{raw_path}") from exc
        if not resolved.is_dir():
            raise ValueError(f"项目目录不是文件夹：{raw_path}")
        path = str(resolved)
        key = os.path.normcase(path)
        if key in path_keys:
            raise ValueError(f"项目中不能添加重复目录：{raw_path}")
        path_keys.add(key)
        normalized.append(path)
    return tuple(normalized)


def _request_hash(name: str, roots: tuple[str, ...]) -> str:
    """生成不含随机 ID 的稳定请求摘要。"""
    body = json.dumps({"name": name, "roots": roots}, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()
