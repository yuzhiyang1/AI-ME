"""FastAPI 应用入口。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from aime.composition import Container, build_container
from aime.presentation.api.routes import build_router
from aime.presentation.api.skill_routes import skill_router


def create_app(
    container: Container | None = None,
    *,
    frontend_dist: Path | None = None,
) -> FastAPI:
    """创建可测试、可重复装配的 Web 应用。"""
    resolved_container = container or build_container()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        """让数据库等基础设施服从 FastAPI 生命周期。"""
        await resolved_container.initialize()
        try:
            yield
        finally:
            await resolved_container.close()

    app = FastAPI(title="AI-ME API", version="0.1.0", lifespan=lifespan)
    app.include_router(
        skill_router(resolved_container.skill_service, resolved_container.get_session)
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(
        build_router(
            resolved_container.create_work_item,
            resolved_container.list_work_items,
            resolved_container.list_available_models,
            resolved_container.stream_model_completion,
            resolved_container.create_session,
            resolved_container.get_session,
            resolved_container.list_sessions,
            resolved_container.start_turn,
            resolved_container.get_active_turn,
            resolved_container.get_turn_by_client_request,
            resolved_container.list_session_items,
            resolved_container.list_runtime_events,
            resolved_container.get_session_token_usage,
            resolved_container.interrupt_turn,
            resolved_container.list_pending_approvals,
            resolved_container.decide_approval,
            resolved_container.list_tool_invocations,
            resolved_container.model_configuration_service,
            resolved_container.create_project,
            resolved_container.list_projects,
            resolved_container.get_project,
            resolved_container.update_project,
            resolved_container.delete_project,
        ),
    )
    resolved_frontend_dist = (
        frontend_dist or Path(__file__).resolve().parents[3] / "frontend" / "dist"
    )
    if resolved_frontend_dist.is_dir():
        # 生产桌面端从后端同源加载构建产物，避免放宽本地 API 的跨域边界。
        app.mount(
            "/app",
            StaticFiles(directory=resolved_frontend_dist, html=True),
            name="app",
        )
    return app


app = create_app()
