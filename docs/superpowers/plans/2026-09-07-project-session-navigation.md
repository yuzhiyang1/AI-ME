# Project-scoped Session Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI-ME 增加可持久化的多目录项目、项目内会话与独立任务分组，并在侧栏同步展示每条会话的上下文圆环。

**Architecture:** Project 负责会话创建时的目录模板和侧栏归组，AgentSession 保存独立的主目录及全部 workspace roots 快照。项目 CRUD、Session 创建、Runtime 多根目录授权和侧栏读取投影分别通过应用端口连接，由 SQLite 适配器实现，前端只消费稳定 HTTP/SSE 契约。

**Tech Stack:** Python 3.11+、FastAPI、SQLAlchemy Core、Alembic、SQLite、pytest、React 19、TypeScript、Vitest、Testing Library、Vite、Electron。

**Spec:** `docs/superpowers/specs/2026-09-07-project-session-navigation-design.md`

## Global Constraints

- 保持依赖方向 `presentation -> application -> domain`，由 `composition.py` 装配基础设施实现。
- Domain 不得依赖 FastAPI、Pydantic、SQLAlchemy、模型 SDK 或具体 Agent 框架。
- 项目至少一个目录；有序 roots 的第一个目录是唯一主目录。
- Project 修改不改变已经创建的 Session workspace roots 快照。
- Project 删除只解除 Session 归属，不删除 Session、Turn、Run、Event 或 Item。
- 相对工具路径从主目录解析；绝对工具路径只能位于 Session 的任一 workspace root 内。
- 前端沿用克制工作台风格，紫色只用于品牌、主操作、选中与健康上下文状态。
- 新增和修改的维护者说明及必要代码注释使用中文。
- Windows pytest 使用仓库内 `--basetemp output/<unique-name>`，避开全局临时目录权限污染。

---

## File Structure

### Backend additions

- `backend/src/aime/domain/projects/entities.py`：Project 聚合与 root 顺序不变量。
- `backend/src/aime/domain/projects/repositories.py`：ProjectRepository 端口及幂等创建结果。
- `backend/src/aime/application/projects/commands.py`：创建、更新 Project 的应用输入。
- `backend/src/aime/application/projects/services.py`：目录规范化、Project CRUD 用例。
- `backend/src/aime/infrastructure/persistence/sqlite_project_repository.py`：Project 与 roots 的 SQLite 事务适配器。
- `backend/src/aime/infrastructure/persistence/migrations/versions/0005_projects_and_session_roots.py`：Project、roots、幂等键、Session 归属与快照迁移。
- `backend/tests/test_project_api.py`：通过 HTTP 公开接口验证 Project 行为。

### Backend modifications

- `backend/src/aime/domain/sessions/entities.py`：Session 增加 `project_id` 与 `workspace_roots`。
- `backend/src/aime/domain/sessions/repositories.py`：支持在创建事务中保存 Session roots。
- `backend/src/aime/application/sessions/commands.py`：创建请求支持互斥的 project/workspace 来源。
- `backend/src/aime/application/sessions/services.py`：从 Project 生成 Session 运行快照。
- `backend/src/aime/application/ports/agent_runtime.py`：AgentRunRequest 携带全部 workspace roots。
- `backend/src/aime/application/ports/tool_execution.py`：ToolExecutionContext 携带全部 workspace roots。
- `backend/src/aime/application/ports/conversation_store.py`：会话列表读取投影增加上下文摘要。
- `backend/src/aime/infrastructure/persistence/sqlite_database.py`：声明新增表、外键与索引。
- `backend/src/aime/infrastructure/persistence/sqlite_session_repository.py`：写入和读取 Session roots。
- `backend/src/aime/infrastructure/persistence/sqlite_conversation_store.py`：读取 Session roots 与批量 usage 摘要。
- `backend/src/aime/infrastructure/runtime/model_agent_runtime.py`：主目录和附加目录进入提示与工具上下文。
- `backend/src/aime/infrastructure/tools/builtin.py`：多 root 路径解析及稳定展示路径。
- `backend/src/aime/presentation/api/schemas.py`：Project、Session roots、Session summary DTO。
- `backend/src/aime/presentation/api/routes.py`：Project CRUD 和扩展 Session 接口。
- `backend/src/aime/composition.py`、`backend/src/aime/main.py`：装配 Project 用例。

### Frontend additions

- `frontend/src/SessionSidebar.tsx`：项目/任务分组、展开状态与会话圆环。
- `frontend/src/SessionContextRing.tsx`：可复用的小型上下文圆环。
- `frontend/src/ProjectDialog.tsx`：项目新增与编辑弹窗。
- `frontend/src/SessionSidebar.test.tsx`：侧栏归组、空状态和圆环测试。
- `frontend/src/ProjectDialog.test.tsx`：目录顺序、主目录和提交测试。

### Frontend modifications

- `frontend/src/SessionUsageBar.tsx`：复用圆环组件，避免两份进度算法。
- `frontend/src/api.ts`：Project、workspace roots、Session summary API 契约。
- `frontend/src/App.tsx`：项目状态、CRUD、两种 Session 创建和 SSE 同步编排。
- `frontend/src/App.test.tsx`：端到端组件行为与异步隔离。
- `frontend/src/styles.css`：项目导航、嵌套会话和弹窗样式。
- `desktop/src/preload.cts`、`frontend/src/desktop.d.ts`：复用现有目录选择器完成多次选目录。

---

### Task 1: Project 领域模型、迁移与 CRUD API

**Files:**
- Create: `backend/src/aime/domain/projects/__init__.py`
- Create: `backend/src/aime/domain/projects/entities.py`
- Create: `backend/src/aime/domain/projects/repositories.py`
- Create: `backend/src/aime/application/projects/__init__.py`
- Create: `backend/src/aime/application/projects/commands.py`
- Create: `backend/src/aime/application/projects/services.py`
- Create: `backend/src/aime/infrastructure/persistence/sqlite_project_repository.py`
- Create: `backend/src/aime/infrastructure/persistence/migrations/versions/0005_projects_and_session_roots.py`
- Create: `backend/tests/test_project_api.py`
- Modify: `backend/src/aime/infrastructure/persistence/sqlite_database.py`
- Modify: `backend/src/aime/presentation/api/schemas.py`
- Modify: `backend/src/aime/presentation/api/routes.py`
- Modify: `backend/src/aime/composition.py`
- Modify: `backend/src/aime/main.py`
- Modify: `backend/tests/test_database_migrations.py`

**Interfaces:**
- Produces: `Project.create(name: str, roots: tuple[str, ...], position: int) -> Project`。
- Produces: `ProjectRepository.create(project, idempotency_key, request_hash) -> ProjectCreateResult`。
- Produces: `CreateProject`, `ListProjects`, `GetProject`, `UpdateProject`, `DeleteProject`。
- Produces: `/api/projects` CRUD，roots 数组顺序定义主目录。

- [ ] **Step 1: 写 Project 创建与读取的失败测试**

```python
def test_project_create_persists_ordered_roots_and_is_idempotent(client, two_roots):
    payload = {
        "name": "  AI-ME  ",
        "roots": [{"path": str(two_roots[0])}, {"path": str(two_roots[1])}],
        "idempotencyKey": "project-create-1",
    }
    first = client.post("/api/projects", json=payload)
    repeated = client.post("/api/projects", json=payload)
    assert first.status_code == 201
    assert repeated.json() == first.json()
    assert first.json()["name"] == "AI-ME"
    assert first.json()["roots"][0]["primary"] is True
```

- [ ] **Step 2: 运行测试并确认接口尚不存在**

Run: `uv run pytest tests/test_project_api.py -q --basetemp output/project-api-red`

Expected: FAIL，`POST /api/projects` 返回 404。

- [ ] **Step 3: 实现 Project 聚合和仓储端口**

```python
@dataclass(frozen=True, slots=True)
class ProjectRoot:
    path: str
    position: int

    @property
    def primary(self) -> bool:
        return self.position == 0


@dataclass(slots=True)
class Project:
    id: UUID
    name: str
    roots: tuple[ProjectRoot, ...]
    position: int
    created_at: datetime
    updated_at: datetime
```

Repository 端口必须提供 `create`、`get`、`list_all`、`update`、`delete`；`create` 在同一事务写 Project、roots 与幂等键。

- [ ] **Step 4: 实现迁移与 SQLite 适配器**

迁移 revision 使用：

```python
revision = "0005_projects_and_session_roots"
down_revision = "0004_model_configurations"
```

创建 `projects`、`project_roots`、`session_workspace_roots`、`project_idempotency_keys`，并向 `agent_sessions` 增加可空 `project_id`。迁移中执行：

```sql
INSERT INTO session_workspace_roots (session_id, position, path, path_key)
SELECT id, 0, workspace_path, lower(workspace_path)
FROM agent_sessions;
```

- [ ] **Step 5: 实现应用用例和 HTTP DTO**

```python
@dataclass(frozen=True, slots=True)
class CreateProjectCommand:
    name: str
    roots: tuple[str, ...]
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class UpdateProjectCommand:
    project_id: UUID
    name: str
    roots: tuple[str, ...]
```

目录通过 `Path(path).expanduser().resolve(strict=True)` 规范化；Windows `path_key` 使用 `os.path.normcase(str(path))`。

- [ ] **Step 6: 增加错误与删除语义测试并实现**

覆盖空 roots、重复真实目录、文件路径、未知 Project、幂等冲突，以及删除后 Project 404。错误分别稳定为 422、404、409。

- [ ] **Step 7: 运行 Project 和迁移测试**

Run: `uv run pytest tests/test_project_api.py tests/test_database_migrations.py -q --basetemp output/project-api-green`

Expected: PASS。

- [ ] **Step 8: 提交 Project 后端切片**

```powershell
git add backend/src/aime/domain/projects backend/src/aime/application/projects backend/src/aime/infrastructure/persistence backend/src/aime/presentation backend/src/aime/composition.py backend/src/aime/main.py backend/tests/test_project_api.py backend/tests/test_database_migrations.py
git commit -m "feat: add persistent multi-root projects"
```

---

### Task 2: Session 项目归属与目录快照

**Files:**
- Modify: `backend/src/aime/domain/sessions/entities.py`
- Modify: `backend/src/aime/domain/sessions/repositories.py`
- Modify: `backend/src/aime/application/sessions/commands.py`
- Modify: `backend/src/aime/application/sessions/services.py`
- Modify: `backend/src/aime/infrastructure/persistence/sqlite_session_repository.py`
- Modify: `backend/src/aime/infrastructure/persistence/sqlite_conversation_store.py`
- Modify: `backend/src/aime/presentation/api/schemas.py`
- Modify: `backend/src/aime/presentation/api/routes.py`
- Modify: `backend/src/aime/composition.py`
- Modify: `backend/tests/test_session_api.py`

**Interfaces:**
- Consumes: `ProjectRepository.get(ProjectId)` 与 Project ordered roots。
- Produces: `AgentSession.project_id: UUID | None`。
- Produces: `AgentSession.workspace_roots: tuple[str, ...]`。
- Produces: `CreateSessionCommand(project_id: UUID | None, workspace_path: str | None, ...)`。

- [ ] **Step 1: 写两种 Session 创建方式的失败测试**

```python
def test_project_session_snapshots_all_project_roots(client, created_project):
    response = client.post("/api/sessions", json={
        "projectId": created_project["id"],
        "defaultModel": "openai/gpt-5",
        "permissionProfile": "workspace_write",
    })
    assert response.status_code == 201
    assert response.json()["projectId"] == created_project["id"]
    assert response.json()["workspaceRoots"] == [
        root["path"] for root in created_project["roots"]
    ]


def test_standalone_session_has_no_project(client, workspace):
    response = client.post("/api/sessions", json={
        "workspacePath": str(workspace),
        "defaultModel": "openai/gpt-5",
        "permissionProfile": "workspace_write",
    })
    assert response.json()["projectId"] is None
    assert response.json()["workspaceRoots"] == [str(workspace.resolve())]
```

- [ ] **Step 2: 运行测试确认缺少新契约**

Run: `uv run pytest tests/test_session_api.py -k "project_session or standalone_session" -q --basetemp output/session-roots-red`

Expected: FAIL，响应缺少 `projectId` 或 `workspaceRoots`。

- [ ] **Step 3: 扩展 AgentSession 与 CreateSessionCommand**

```python
@dataclass(slots=True)
class AgentSession:
    project_id: UUID | None
    workspace_path: str
    workspace_roots: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CreateSessionCommand:
    project_id: UUID | None
    workspace_path: str | None
    default_model: str
    permission_profile: PermissionProfile
```

- [ ] **Step 4: 实现互斥校验和快照创建**

```python
if command.project_id is not None and command.workspace_path is not None:
    raise ValueError("项目会话不能覆盖项目目录")
if command.project_id is None and command.workspace_path is None:
    raise ValueError("独立会话必须选择工作目录")
```

项目会话从 ProjectRepository 读取 roots；独立会话解析单目录。SessionRepository.add 在同一事务写 `agent_sessions` 和 `session_workspace_roots`。

- [ ] **Step 5: 验证项目更新和删除不破坏 Session**

测试先创建 Project Session，再修改 Project roots，断言 Session roots 不变；删除 Project 后断言 `projectId` 为 null、roots 仍不变、历史 items 仍可读。

- [ ] **Step 6: 运行 Session 与 Project 回归**

Run: `uv run pytest tests/test_session_api.py tests/test_project_api.py -q --basetemp output/session-roots-green`

Expected: PASS。

- [ ] **Step 7: 提交 Session 快照切片**

```powershell
git add backend/src/aime/domain/sessions backend/src/aime/application/sessions backend/src/aime/infrastructure/persistence backend/src/aime/presentation backend/src/aime/composition.py backend/tests/test_session_api.py backend/tests/test_project_api.py
git commit -m "feat: bind sessions to project root snapshots"
```

---

### Task 3: Runtime 多根目录与文件工具边界

**Files:**
- Modify: `backend/src/aime/application/ports/agent_runtime.py`
- Modify: `backend/src/aime/application/ports/tool_execution.py`
- Modify: `backend/src/aime/application/sessions/runtime_coordinator.py`
- Modify: `backend/src/aime/infrastructure/runtime/model_agent_runtime.py`
- Modify: `backend/src/aime/infrastructure/tools/builtin.py`
- Modify: `backend/tests/test_builtin_tools.py`
- Modify: `backend/tests/test_agent_tool_loop.py`
- Modify: `backend/tests/test_runtime_recovery.py`

**Interfaces:**
- Consumes: `AgentSession.workspace_roots` 快照。
- Produces: `AgentRunRequest.workspace_roots: tuple[str, ...]`。
- Produces: `ToolExecutionContext.workspace_roots: tuple[str, ...]`。
- Produces: `_workspace_path(context, raw_path, must_exist) -> Path` 支持授权绝对路径。

- [ ] **Step 1: 写附加目录读写与越界失败测试**

```python
async def test_file_tools_allow_secondary_root_and_reject_outside(tmp_path):
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    outside = tmp_path / "outside"
    for directory in (primary, secondary, outside):
        directory.mkdir()
    context = tool_context(primary, (primary, secondary))
    await WriteFileTool().execute(
        {"path": str(secondary / "ok.txt"), "content": "ok"}, context
    )
    with pytest.raises(ToolInputError, match="授权工作区"):
        await ReadFileTool().execute({"path": str(outside / "secret.txt")}, context)
```

- [ ] **Step 2: 运行测试确认绝对路径仍被拒绝**

Run: `uv run pytest tests/test_builtin_tools.py -k "secondary_root or outside" -q --basetemp output/multi-root-red`

Expected: FAIL，现有实现提示“path 必须是相对工作区的路径”。

- [ ] **Step 3: 扩展 Runtime 和 Tool 上下文**

```python
@dataclass(frozen=True, slots=True)
class ToolExecutionContext:
    session_id: str
    turn_id: str
    run_id: str
    workspace_path: str
    workspace_roots: tuple[str, ...]
    permission_profile: PermissionProfile
```

RuntimeCoordinator 从 `TurnExecution.session.workspace_roots` 生成 AgentRunRequest；ModelAgentRuntime 原样传入 ToolExecutionContext。

- [ ] **Step 4: 实现多 root 安全路径解析**

```python
def _workspace_path(context, raw_path: str, *, must_exist: bool) -> Path:
    roots = tuple(Path(root).resolve(strict=True) for root in context.workspace_roots)
    candidate = Path(raw_path)
    unresolved = candidate if candidate.is_absolute() else roots[0] / candidate
    resolved = unresolved.resolve(strict=must_exist)
    if not any(_is_relative_to(resolved, root) for root in roots):
        raise ToolInputError("path 不能离开会话授权工作区")
    if not must_exist:
        parent = resolved.parent.resolve(strict=True)
        if not any(_is_relative_to(parent, root) for root in roots):
            raise ToolInputError("目标父目录不能离开会话授权工作区")
    return resolved
```

工具输出路径在主目录内继续返回相对路径；附加目录返回规范化绝对路径，避免同名 root 产生歧义。

- [ ] **Step 5: 向模型声明多目录上下文**

System 指令追加确定性段落：

```text
当前会话主目录：<primary>
附加授权目录：
- <secondary-1>
- <secondary-2>
相对工具路径默认相对于主目录；访问附加目录时使用绝对路径。
```

- [ ] **Step 6: 增加符号链接/目录连接逃逸和恢复测试**

Unix 可创建 symlink 时验证逃逸被拒绝；Windows 无权限创建链接时显式 skip。恢复测试断言重启后 AgentRunRequest 仍收到原 Session roots 快照。

- [ ] **Step 7: 运行 Runtime 与工具测试**

Run: `uv run pytest tests/test_builtin_tools.py tests/test_agent_tool_loop.py tests/test_runtime_recovery.py -q --basetemp output/multi-root-green`

Expected: PASS。

- [ ] **Step 8: 提交多 root Runtime**

```powershell
git add backend/src/aime/application/ports backend/src/aime/application/sessions/runtime_coordinator.py backend/src/aime/infrastructure/runtime backend/src/aime/infrastructure/tools backend/tests/test_builtin_tools.py backend/tests/test_agent_tool_loop.py backend/tests/test_runtime_recovery.py
git commit -m "feat: authorize tools across session workspace roots"
```

---

### Task 4: Session 列表上下文摘要投影

**Files:**
- Modify: `backend/src/aime/application/ports/conversation_store.py`
- Modify: `backend/src/aime/application/sessions/services.py`
- Modify: `backend/src/aime/infrastructure/persistence/sqlite_conversation_store.py`
- Modify: `backend/src/aime/presentation/api/schemas.py`
- Modify: `backend/src/aime/presentation/api/routes.py`
- Modify: `backend/tests/test_session_api.py`

**Interfaces:**
- Produces: `SessionContextUsageSummary(current_context_tokens, context_window, percentage, partial)`。
- Produces: `SessionListItem(session, context_usage)`。
- Produces: `GET /api/sessions` 的 `contextUsage` 嵌套字段。

- [ ] **Step 1: 写批量列表投影失败测试**

```python
def test_session_list_returns_context_usage_for_every_session(client):
    sessions = create_measured_and_unmeasured_sessions(client)
    listed = client.get("/api/sessions").json()
    by_id = {item["id"]: item for item in listed}
    assert by_id[sessions.measured]["contextUsage"]["percentage"] == 56
    assert by_id[sessions.unmeasured]["contextUsage"] == {
        "currentContextTokens": None,
        "contextWindow": 32000,
        "percentage": None,
        "partial": True,
    }
```

- [ ] **Step 2: 运行测试确认缺少 contextUsage**

Run: `uv run pytest tests/test_session_api.py -k "list_returns_context_usage" -q --basetemp output/session-summary-red`

Expected: FAIL，列表项没有 `contextUsage`。

- [ ] **Step 3: 实现一次查询的批量聚合**

SQLite 适配器一次读取全部 Session，并只关联每个 Session 最新 `model_usage` 事件；不得循环调用 `get_token_usage(session_id)`。百分比使用：

```python
percentage = (
    min(100, round(current_context_tokens / context_window * 100))
    if current_context_tokens is not None and context_window
    else None
)
```

- [ ] **Step 4: 保留单 Session 精确累计接口**

`GET /api/sessions/{id}/usage` 继续返回输入、输出、合计和步数；列表摘要只承担侧栏展示，不重复累计统计。

- [ ] **Step 5: 运行 Session API 全量测试**

Run: `uv run pytest tests/test_session_api.py -q --basetemp output/session-summary-green`

Expected: PASS。

- [ ] **Step 6: 提交读取投影**

```powershell
git add backend/src/aime/application backend/src/aime/infrastructure/persistence/sqlite_conversation_store.py backend/src/aime/presentation backend/tests/test_session_api.py
git commit -m "feat: include context pressure in session summaries"
```

---

### Task 5: 前端项目/任务侧栏与共享圆环

**Files:**
- Create: `frontend/src/SessionContextRing.tsx`
- Create: `frontend/src/SessionSidebar.tsx`
- Create: `frontend/src/SessionSidebar.test.tsx`
- Modify: `frontend/src/SessionUsageBar.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `Project[]`、带 `projectId`/`contextUsage` 的 `AgentSession[]`。
- Produces: `SessionContextRing({ usage, size, label })`。
- Produces: `SessionSidebar({ projects, sessions, activeSessionId, ... })`。

- [ ] **Step 1: 写侧栏归组和圆环失败测试**

```tsx
it("按项目与任务归组会话并展示各自上下文圆环", () => {
  render(<SessionSidebar projects={[projectA]} sessions={[projectSession, taskSession]} />);
  expect(screen.getByRole("group", { name: "项目 AI-ME" })).toHaveTextContent("项目会话");
  expect(screen.getByRole("group", { name: "任务" })).toHaveTextContent("独立会话");
  expect(screen.getByRole("progressbar", { name: "项目会话上下文占用" }))
    .toHaveAttribute("aria-valuenow", "56");
});
```

- [ ] **Step 2: 运行测试确认组件不存在**

Run: `npm test -- --run src/SessionSidebar.test.tsx`

Expected: FAIL，无法导入 `SessionSidebar`。

- [ ] **Step 3: 扩展前端 API 类型**

```ts
export interface ProjectRoot { path: string; position: number; primary: boolean }
export interface Project { id: string; name: string; roots: ProjectRoot[]; position: number }
export interface SessionContextUsage {
  currentContextTokens: number | null;
  contextWindow: number | null;
  percentage: number | null;
  partial: boolean;
}
```

AgentSession 增加 `projectId`、`workspaceRoots` 和 `contextUsage`。

- [ ] **Step 4: 提取共享 SessionContextRing**

```tsx
export function SessionContextRing({ usage, label, size = 17 }: Props) {
  const percentage = usage?.percentage ?? null;
  return <span role="progressbar" aria-label={label} aria-valuenow={percentage ?? undefined}>...</span>;
}
```

`SessionUsageBar` 复用该组件，删除重复 SVG 和阈值函数。

- [ ] **Step 5: 实现分组侧栏**

Project 默认展开；用户点击 Project 行切换本地展开状态。项目会话按 `updatedAt` 降序排列；`projectId = null` 的会话进入“任务”。无会话项目显示“暂无会话”。

- [ ] **Step 6: 接入 App 并同步 SSE usage**

App bootstrap 并行加载 projects 与 sessions。收到当前会话 `model_usage` 后，刷新精确 usage，并用同一百分比更新 sessions state 中对应列表项；禁止为每个列表项发 `/usage` 请求。

- [ ] **Step 7: 运行前端组件和 App 测试**

Run: `npm test -- --run src/SessionSidebar.test.tsx src/App.test.tsx`

Expected: PASS。

- [ ] **Step 8: 提交侧栏切片**

```powershell
git add frontend/src/SessionContextRing.tsx frontend/src/SessionSidebar.tsx frontend/src/SessionSidebar.test.tsx frontend/src/SessionUsageBar.tsx frontend/src/api.ts frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/styles.css
git commit -m "feat: group sessions by project in the sidebar"
```

---

### Task 6: Project 弹窗与两种会话创建流程

**Files:**
- Create: `frontend/src/ProjectDialog.tsx`
- Create: `frontend/src/ProjectDialog.test.tsx`
- Modify: `frontend/src/SessionSidebar.tsx`
- Modify: `frontend/src/SessionSidebar.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/styles.css`
- Modify: `desktop/src/preload.cts`
- Modify: `frontend/src/desktop.d.ts`

**Interfaces:**
- Consumes: `createProject`、`updateProject`、`deleteProject`、扩展后的 `createSession`。
- Produces: `ProjectDialog` 的完整 roots 数组，第一项为主目录。
- Produces: `showNewSession(project?: Project)`，区分项目会话和独立会话。

- [ ] **Step 1: 写项目弹窗失败测试**

```tsx
it("添加目录、设为主目录并按新顺序提交", async () => {
  const onSave = vi.fn();
  render(<ProjectDialog open project={projectA} onChooseFolder={chooseFolder} onSave={onSave} />);
  await user.click(screen.getByRole("button", { name: "添加文件夹" }));
  await user.click(screen.getByRole("button", { name: "将 maka 设为主要" }));
  await user.click(screen.getByRole("button", { name: "保存项目" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    roots: ["D:\\workspac\\maka", "D:\\workspac\\AI-ME"],
  }));
});
```

- [ ] **Step 2: 运行测试确认组件不存在**

Run: `npm test -- --run src/ProjectDialog.test.tsx`

Expected: FAIL，无法导入 `ProjectDialog`。

- [ ] **Step 3: 实现 ProjectDialog**

弹窗包含项目名称、roots 列表、“主要”标记、移除按钮和“添加文件夹”。“设为主要”通过把目标 root 移到数组第一位实现；最后一个 root 不允许移除。

- [ ] **Step 4: 实现项目 CRUD API 客户端**

```ts
export function createProject(input: CreateProjectInput): Promise<Project>;
export function updateProject(projectId: string, input: UpdateProjectInput): Promise<Project>;
export function deleteProject(projectId: string): Promise<void>;
```

创建时使用 `crypto.randomUUID()` 生成 idempotencyKey，并在网络重试期间复用同一个值。

- [ ] **Step 5: 实现项目内新建会话**

项目行“新建会话”调用 `showNewSession(project)`；新会话页面展示只读的主目录与附加目录摘要，提交载荷只含 `projectId`、模型和权限。顶部“新对话”调用 `showNewSession()`，保留单目录选择器。

- [ ] **Step 6: 实现项目删除确认**

确认文案固定为：“删除项目后，其中的会话会移到任务，历史消息与运行记录不会删除。”成功后重新批量读取 projects/sessions，保持当前会话打开。

- [ ] **Step 7: 覆盖延迟请求和失败恢复**

测试 Project 保存失败时弹窗保留输入并显示错误；快速切换项目会话时旧 Session 请求不能覆盖新页面；删除当前项目后当前 Session 的 `projectId` 在列表中变为 null。

- [ ] **Step 8: 运行前端全量测试和类型检查**

Run: `npm test -- --run; npm run typecheck`

Expected: PASS。

- [ ] **Step 9: 提交创建与管理流程**

```powershell
git add frontend/src desktop/src
git commit -m "feat: manage projects and create scoped sessions"
```

---

### Task 7: 真实联调、视觉验收与完整回归

**Files:**
- Modify: `README.md`
- Modify: `docs/Agent会话与Runtime设计.md`
- Test evidence only: `output/playwright/project-session-navigation.png`

**Interfaces:**
- Consumes: Tasks 1–6 的公开 API 与 UI。
- Produces: Windows 双目录真实验收证据和可复现启动说明。

- [ ] **Step 1: 更新维护文档**

README 增加项目创建、多目录、项目会话和独立任务说明；Runtime 文档明确 `workspace_path` 是 cwd、`workspace_roots` 是授权集合、Session 使用快照语义。

- [ ] **Step 2: 执行数据库升级测试**

Run: `uv run pytest tests/test_database_migrations.py -q --basetemp output/final-migrations`

Expected: PASS，并确认旧 Session 获得单 root 快照。

- [ ] **Step 3: 运行后端完整质量门禁**

Run: `uv run pytest -q --basetemp output/final-backend; uv run ruff check src tests; uv run mypy src/aime`

Expected: 全部 PASS，仅允许仓库已有的 Starlette deprecation warning。

- [ ] **Step 4: 运行前端完整质量门禁**

Run: `npm test -- --run; npm run typecheck; npm run build`

Expected: 全部 PASS。

- [ ] **Step 5: 在真实桌面应用创建双目录 Project**

使用两个新的临时目录：

```text
<temp>/primary/readme.txt
<temp>/secondary/reference.txt
```

在 UI 中创建项目，确认 primary 显示“主要”，secondary 显示为附加目录；从项目下创建会话。

- [ ] **Step 6: 验证跨目录和越界行为**

通过 Agent 工具读取两个目录的文件，并请求读取第三个未授权目录；前两次成功，第三次返回稳定授权错误。删除测试 Project 后确认 Session 出现在“任务”区域且消息仍存在。

- [ ] **Step 7: 进行视觉和无障碍验收**

使用 Playwright 检查项目分组、展开、空状态、选中会话和上下文圆环；保存 viewport 截图。验证 Project group、Task group、按钮、对话框和 progressbar 都有稳定 aria name。

- [ ] **Step 8: 检查变更范围并提交文档**

Run: `git diff --check; git status --short`

只暂存 README 与 Runtime 文档：

```powershell
git add README.md docs/Agent会话与Runtime设计.md
git commit -m "docs: document project-scoped sessions"
```

- [ ] **Step 9: 最终审计**

Run: `git status --short; git log --oneline -8`

Expected: 工作树干净，Task 1–7 每个切片都有独立提交，未修改主工作树和无关文件。
