# AI-ME

AI-ME 是一个面向技术负责人的个人工作噪音托管 Agent，采用客户端优先（Desktop-first）的产品形态。

当前仓库是从零开始的新工程骨架：后端采用 Python 模块化单体、DDD 与洋葱架构；Electron 客户端复用 React + TypeScript 渲染层，并保留 Multica 式简洁工作台和 AI-ME 紫色品牌调性。Web 能力继续保留，现阶段只用于开发预览和未来远程访问。

## 目录

```text
backend/
├── src/aime/
│   ├── domain/          # 领域实体、值对象、规则与端口
│   ├── application/     # 用例编排与外部能力端口
│   ├── infrastructure/  # 存储、模型、工具和集成适配器
│   ├── presentation/    # FastAPI、DTO 与协议适配
│   └── composition.py   # 单一装配根
└── tests/

frontend/
├── src/                # 客户端与 Web 共用的 React 渲染层
└── public/

desktop/
└── src/                # Electron 主进程与受控预加载桥

docs/
└── architecture.md
```

## 默认启动：桌面客户端

首次准备依赖：

```powershell
cd backend
uv sync --dev

cd ..\frontend
npm install

cd ..\desktop
npm install
npm run build
```

之后日常启动只需要从 `desktop` 目录执行：

```powershell
npm start
```

该命令会启动本地 FastAPI 和 Electron 窗口。日常启用和使用 AI-ME 时，以这个客户端入口为准；关闭客户端后，本地服务也会随之退出。

开发客户端时使用 `npm run dev`，它会额外启动 React 热更新服务。

## 保留的 Web 模式

Web 目前不是主要产品入口，只用于调试共享渲染层，并为未来远程功能保留：

```powershell
cd frontend
npm run dev
```

预览地址：`http://127.0.0.1:5173`。后端仍可独立启动，健康检查为 `http://127.0.0.1:8000/api/health`。

## 验证

```powershell
cd backend
uv run pytest
uv run ruff check src tests
uv run mypy src

cd ..\frontend
npm run build

cd ..\desktop
npm run typecheck
npm run build
```

## 架构原则

- 单仓库、单后端、单数据库、单部署单元。
- Electron 是默认产品入口，React 是共享渲染层，Web 是未来远程适配入口。
- DDD 用于表达工作请求、Agent Run、SOP、证据与审批规则，不等于微服务。
- Agent Runtime、LLM、数据库和外部工具都是可替换适配器。
- 先完成真实纵向用例，再扩展基础设施。

详细说明见 [docs/architecture.md](docs/architecture.md)。

## License

Apache-2.0

