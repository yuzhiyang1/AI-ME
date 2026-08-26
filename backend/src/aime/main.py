"""FastAPI 应用入口。"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from aime.composition import build_container
from aime.presentation.api.routes import build_router


def create_app() -> FastAPI:
    """创建可测试、可重复装配的 Web 应用。"""
    container = build_container()
    app = FastAPI(title="AI-ME API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(
        build_router(
            container.create_work_item,
            container.list_work_items,
            container.model_gateway,
        ),
    )
    return app


app = create_app()

