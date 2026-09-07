# AI-ME 项目、会话分组与多目录 Runtime 设计

## 1. 背景

AI-ME 当前只有会话列表，每条会话直接绑定一个 `workspace_path`。这能支撑单目录 Coding Agent，但无法表达以下用户需求：

- 在左侧创建和管理项目，并在项目下创建会话。
- 创建不绑定项目的独立会话，并统一放在“任务”区域。
- 一个项目关联多个本地目录，其中恰好一个是主目录。
- 项目会话以主目录作为默认工作目录，同时允许 Agent 访问项目的其他目录。
- 左侧每条会话同步显示上下文占用圆环。

本设计参考 Codex 对 `Project`、`projectId`、`cwd` 与 `runtimeWorkspaceRoots` 的职责拆分，但保留 AI-ME 自己的领域边界和持久化模型。

## 2. 目标与非目标

### 2.1 本期目标

1. 将 Project 建模为独立、可持久化的领域对象。
2. 支持项目新增、读取、编辑和删除。
3. 支持一个项目配置多个有序目录，第一个目录是主目录。
4. 支持项目会话与独立会话两种创建方式。
5. 将项目目录复制为会话级运行快照，保证恢复和重放稳定。
6. 让内置文件工具安全访问会话的全部授权目录。
7. 在侧栏按“项目 / 任务”组织会话，并批量展示上下文进度。
8. 为迁移、错误路径、幂等、安全边界和真实浏览器流程提供自动化证据。

### 2.2 二期范围

- 把已有会话手动移动到项目或另一个项目。
- 拖拽调整项目顺序。
- 全局搜索、项目内搜索和归档管理。
- 项目级默认模型、默认权限及其他运行模板。

### 2.3 明确不做

- 不把 Project 变成通用插件或远程工作空间系统。
- 不让项目配置在后台静默改写历史会话的运行目录。
- 不用前端临时分组代替后端持久 Project。
- 不在本期引入多用户、团队权限或云端同步。

## 3. 参考方案与取舍

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| Project 与 Session 分开持久化 | 采用 | 项目负责组织与创建模板，会话负责可恢复运行事实 |
| Session 使用可空 `project_id` | 采用 | `null` 可稳定表达“不绑定项目的任务” |
| `cwd` 与可访问根目录集合分离 | 采用 | 主目录承担默认相对路径，全部根目录承担授权范围 |
| 有序 roots 的第一项表示主目录 | 采用 | 与编辑界面和 Codex 的有序 roots 模型一致，契约简单 |
| 项目更新动态改变旧会话目录 | 拒绝 | 会导致恢复、审计和后续 Turn 的运行环境漂移 |
| 只在前端按路径分组 | 拒绝 | 无法可靠表达多目录、项目身份和工具授权 |

## 4. 领域模型

### 4.1 Project

```text
Project
├── id: ProjectId
├── name: ProjectName
├── roots: ProjectRoot[]
├── position: int
├── created_at: datetime
└── updated_at: datetime
```

`ProjectRoot` 包含：

- `path`：解析后的绝对目录路径。
- `path_key`：仅用于持久化去重的规范化键；Windows 下不区分大小写。
- `position`：从 `0` 连续递增；`position = 0` 的目录是主目录。

领域不变量：

1. 项目名称去除首尾空白后不能为空，最大长度为 120。
2. 项目至少包含一个目录。
3. 每个目录必须真实存在并且是目录。
4. 逻辑路径和解析后的真实路径都不得重复。
5. root position 必须连续且唯一，因此项目始终恰好有一个主目录。

### 4.2 AgentSession

现有 `AgentSession` 增加：

```text
project_id: ProjectId | None
workspace_roots: SessionWorkspaceRoot[]
```

现有 `workspace_path` 保留，并明确为主目录快照。`workspace_roots[0]` 必须与 `workspace_path` 表示同一个规范化目录。

项目会话创建时：

1. 校验项目存在且处于可用状态。
2. 把项目当前 roots 按顺序复制到 Session。
3. 把第一个 root 写入 `workspace_path`。
4. 写入 `project_id`，用于侧栏归组。

独立会话创建时：

1. `project_id = null`。
2. 用户必须选择一个真实目录。
3. 该目录同时成为 `workspace_path` 和唯一的 `workspace_root`。

项目后续编辑只改变创建新会话时使用的模板。已存在会话继续使用自己的目录快照。

## 5. 持久化设计

新增表：

```text
projects
  id                 PK
  name
  position
  created_at
  updated_at

project_roots
  project_id         FK projects.id ON DELETE CASCADE
  position
  path
  path_key
  PK(project_id, position)
  UNIQUE(project_id, path_key)

session_workspace_roots
  session_id         FK agent_sessions.id ON DELETE CASCADE
  position
  path
  path_key
  PK(session_id, position)
  UNIQUE(session_id, path_key)

project_idempotency_keys
  idempotency_key    PK
  project_id         FK projects.id ON DELETE CASCADE
  request_hash
  created_at
```

修改 `agent_sessions`：

```text
project_id           NULLABLE FK projects.id ON DELETE SET NULL
```

增加 `(project_id, updated_at)` 索引，支持侧栏分组后的最近活动排序。

迁移脚本会为已有 Session 写入一条 `session_workspace_roots`：

- `position = 0`
- `path = workspace_path`
- `project_id = null`

虽然当前仍处于开发阶段、历史数据可以丢弃，迁移仍保持可升级和可回退，避免形成只适用于开发机的特殊流程。

## 6. 应用用例与 API

### 6.1 Project 用例

- `CreateProject`
- `ListProjects`
- `GetProject`
- `UpdateProject`
- `DeleteProject`

创建与更新先在应用层解析、校验所有目录，再进入单个数据库事务。任意目录失败时整次操作不落库。

### 6.2 HTTP API

#### 创建项目

```http
POST /api/projects
```

```json
{
  "name": "AI-ME",
  "roots": [
    { "path": "D:\\workspac\\AI-ME" },
    { "path": "D:\\workspac\\maka" }
  ],
  "idempotencyKey": "客户端生成的稳定 UUID"
}
```

roots 的第一项是主目录。相同幂等键与相同请求返回原 Project；相同幂等键绑定不同请求返回 `409`。

#### 查询与编辑项目

```http
GET    /api/projects
GET    /api/projects/{project_id}
PATCH  /api/projects/{project_id}
DELETE /api/projects/{project_id}
```

`PATCH` 接收完整 roots 新值。修改主目录等价于调整 roots 顺序。删除项目在一个事务中完成，数据库把相关 Session 的 `project_id` 置空；会话运行快照不变。

#### 创建会话

现有 `POST /api/sessions` 扩展为两种互斥输入：

项目会话：

```json
{
  "projectId": "project-id",
  "defaultModel": "provider/model",
  "permissionProfile": "workspace_write"
}
```

独立会话：

```json
{
  "workspacePath": "D:\\workspac\\temporary-task",
  "defaultModel": "provider/model",
  "permissionProfile": "workspace_write"
}
```

请求同时传 `projectId` 与 `workspacePath` 时返回 `422`，避免出现目录来源不明确。

Session 响应增加：

```json
{
  "projectId": "project-id-or-null",
  "workspacePath": "主目录快照",
  "workspaceRoots": ["主目录", "附加目录"]
}
```

#### 侧栏读取投影

`GET /api/sessions` 返回每条会话及其轻量 `contextUsage`：

```json
{
  "currentContextTokens": 18000,
  "contextWindow": 32000,
  "percentage": 56,
  "partial": false
}
```

该投影通过一次聚合查询生成，不允许前端为每条会话调用一次 `/usage`。

### 6.3 稳定错误语义

| 场景 | HTTP 状态 | 用户提示 |
| --- | --- | --- |
| 项目不存在 | 404 | 项目不存在或已删除 |
| 名称为空、roots 为空 | 422 | 项目名称和主目录不能为空 |
| 目录不存在或不是目录 | 422 | 项目目录不存在或不是文件夹 |
| 目录重复或解析到同一真实目录 | 422 | 项目中不能添加重复目录 |
| 幂等键绑定另一请求 | 409 | 重复请求与原项目内容不一致 |
| 项目会话同时提交 workspacePath | 422 | 项目会话不能覆盖项目目录 |

## 7. Runtime 多目录语义

`AgentRunRequest` 与 `ToolExecutionContext` 增加不可变 `workspace_roots`：

```text
workspace_path   = 主目录 / 默认 cwd
workspace_roots  = 当前 Session 的全部授权目录快照
```

Runtime 每次执行使用 Session 快照，并向模型明确提供：

- 主目录绝对路径。
- 附加目录绝对路径列表。
- 相对路径默认相对于主目录。

工具路径规则：

1. 相对路径从 `workspace_path` 解析。
2. 绝对路径可指向任意 `workspace_root` 内部。
3. 读取现有目标时，解析真实路径后再验证是否位于授权根中。
4. 创建新目标时，同时验证规范化目标和最近存在父目录的真实路径。
5. `..`、符号链接、目录连接或大小写别名都不能逃逸授权根。
6. `read_only` 对所有 roots 只读；`workspace_write` 对所有 roots 应用一致的读写策略。

项目 roots 只决定新 Session 的初始快照，不参与运行期间的路径授权查询。

## 8. 左侧导航与交互

侧栏结构：

```text
新建独立会话

项目                                           新增
  项目 A                                       菜单
    会话 A1                                    上下文圆环
    会话 A2                                    上下文圆环
  项目 B                                       菜单
    暂无会话

任务
  独立会话 C                                   上下文圆环
```

### 8.1 项目交互

- “项目”标题右侧新增按钮打开项目弹窗。
- 弹窗支持项目名称、添加目录、移除目录、调整顺序和设为主目录。
- 主目录显示“主要”标记，不能在没有选择新主目录时被移除。
- 项目行可展开或收起。
- 项目行菜单提供编辑和删除。
- 项目行提供新建会话入口；会话表单显示项目目录摘要但不允许临时覆盖。
- 删除项目前明确提示“会话将移到任务，不会删除历史”。

### 8.2 独立会话

- 顶部“新对话”继续创建独立会话。
- 用户选择单个工作目录、模型和权限。
- 创建成功后出现在“任务”区域。

### 8.3 会话状态与上下文圆环

- 每条会话右侧显示与输入框上方一致的小型圆环。
- 没有统计时显示空心圆。
- `< 70%` 使用品牌紫色，`70%–84%` 使用警告色，`>= 85%` 使用危险色。
- 运行状态移到会话图标角标，避免占用圆环位置。
- 当前会话收到 `model_usage` SSE 事件时，同时更新输入区和侧栏中的同一份 usage state。
- 非当前会话使用批量列表投影；切换会话或列表刷新后更新，不创建每会话 SSE 连接。

## 9. 一致性、并发与恢复

- 项目创建以幂等键防止双击和网络重试产生重复数据。
- 项目及 roots 在同一事务内写入或替换。
- 会话创建在同一事务内读取项目并保存 Session roots 快照。
- 项目删除与 Session 解除关联由外键事务保证。
- 活跃 Turn 始终使用启动时读取的 Session 快照；项目编辑不会影响正在运行的 Agent。
- Session 恢复、进程重启和 Event 重放不依赖 Project 是否仍然存在。
- 项目列表和 Session 列表独立加载；其中一项失败时界面保留另一项，并显示局部可恢复错误。

## 10. 测试与验收

### 10.1 领域与应用测试

- 项目至少一个 root，第一项为主目录。
- 空名称、重复路径、同一真实目录别名被拒绝。
- 创建项目请求具备幂等和冲突语义。
- 项目更新替换 roots 且保持顺序。
- 项目会话正确保存项目 roots 快照。
- 独立会话保持 `project_id = null` 和单 root。
- 编辑项目不改变已有 Session roots。
- 删除项目只解除归属，不删除 Session、Turn、Run、Event 或 Item。

### 10.2 Runtime 安全测试

- 相对路径落在主目录。
- 绝对路径可以读写附加目录。
- 主目录与附加目录之外的绝对路径被拒绝。
- `..` 越界被拒绝。
- 通过符号链接或 Windows 目录连接逃逸被拒绝。
- `read_only` 和 `workspace_write` 对多个 roots 的权限一致。

### 10.3 API 与迁移测试

- Project CRUD 的成功、404、409、422 路径。
- 两种 Session 创建请求及互斥字段校验。
- 旧 Session 回填为独立会话和单 workspace root。
- 升级与 downgrade 后数据库结构符合预期。
- Session 列表通过单次请求返回上下文摘要。

### 10.4 前端与真实浏览器验收

- 项目新增、编辑、删除和空状态。
- 项目展开收起及项目内新建会话。
- 独立会话进入“任务”区域。
- 当前会话切换后不会被延迟请求污染。
- 上下文圆环初次批量加载与 `model_usage` 实时同步。
- 在 Windows 创建两个临时目录，以第一个为主目录创建项目。
- 从项目会话分别读取主目录文件与附加目录文件，并验证越界目录被拒绝。
- 执行后端全量测试、前端全量测试、生产构建、Ruff、MyPy 和 `git diff --check`。

## 11. 发布与回滚

- 本期通过一条增量数据库迁移发布，不修改已有迁移历史。
- 启动时迁移失败则应用启动失败并保留原数据库，不进入部分可用状态。
- 回滚前必须确认不存在仍需保留的 Project 配置；downgrade 只删除项目相关表和 Session 新增归属字段，不删除历史会话账本。
- 当前为开发阶段，可在验收时使用干净状态目录验证首次安装，同时仍保留升级路径测试。

## 12. 实施顺序

1. Project 领域模型、Repository 端口、迁移与公开 API。
2. 项目会话、独立会话与 Session roots 快照。
3. Runtime 和内置工具的多 root 授权。
4. Session 列表 usage 聚合投影。
5. 左侧项目导航、项目弹窗和两种会话创建流程。
6. Windows 双目录真实联调和完整回归。
