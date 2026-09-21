# Agent 会话与 Runtime 设计

## 目标

第一期先交付一条真正可用、可恢复的本地 Agent 会话链路：用户可以先建立包含多个本地目录的项目，也可以直接建立不绑定项目的任务；每个会话固定自己的工作区快照和默认模型，连续发送多个 Turn，AI-ME 通过自研 `AgentRuntime` 端口调用模型，并把用户消息、运行事实与最终回答持久化到本机。

这条切片解决“能不能稳定地开始对话、继续对话、重启后找回对话”的问题。工具循环、Skill、MCP 和审批会在这个底座之上继续扩展，不需要推翻会话协议。

## 三层对象

客户端只需要理解三个对象：

- `Project`：可复用的工作区模板，包含一个主目录和零到多个关联目录；
- `Session`：一段可长期继续的任务会话，固定绑定工作区快照、模型和权限档位，可以属于一个项目，也可以作为独立任务存在；
- `Turn`：用户的一次输入以及由它触发的 Agent 工作；
- `Item`：时间线中稳定可渲染的用户消息、Agent 消息或错误。

Runtime 内部保留更精细的对象：

- `AgentRun`：同一 Turn 的一次具体执行尝试；
- `RuntimeEvent`：运行过程中不可变、有序、可按 sequence 重放的事实；
- 后续的 `ToolInvocation`、`ApprovalRequest` 和 `Checkpoint`。

这样可以让客户端协议保持简单，同时为失败恢复、重试、工具审计和 Eval 留出足够精度。

## 核心不变量

- 项目至少有一个已经存在的本地目录，并且恰好有一个主目录；
- 项目下的 Session 在创建时复制项目目录快照；主目录成为 `workspace_path`，完整有序目录集合成为 `workspace_roots`；
- 不绑定项目的 Session 仍必须选择一个已经存在的本地目录，其 `project_id` 为空，`workspace_roots` 只包含该目录；
- 相对路径始终基于主目录解析；绝对路径只有落在任一授权根目录内才允许被文件工具访问；
- 编辑项目只影响以后创建的 Session，不会扩大或缩小已有 Session 的工具权限；
- 删除项目只解除 Session 的项目归属，历史消息、运行记录与工作区快照全部保留；
- 一个 Session 同时最多有一个活跃 Turn；
- 本地进程最多并发执行两个 Session，其余执行在进程内排队；
- `clientRequestId` 在 Session 内唯一并绑定原始输入，网络重试不会再次调用模型；
- RuntimeEvent 在 Session 内使用单调递增 sequence；
- 一个 AgentRun 最终只能收敛到 `completed`、`failed` 或 `interrupted`；
- 完成、失败和中断通过同一个原子 CAS 事务竞争终态，不会产生双终态；
- 进程重启时，缺少 terminal fact 的 Run 会被标记为 `interrupted`，Session 恢复为 `idle`；
- 空模型回答不是成功消息，会形成用户可见错误。

## 请求与事件接口

```text
GET  /api/models
GET  /api/settings/models
POST /api/settings/models
GET  /api/projects
POST /api/projects
GET  /api/projects/{projectId}
PATCH /api/projects/{projectId}
DELETE /api/projects/{projectId}
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/{sessionId}
POST /api/sessions/{sessionId}/turns
GET  /api/sessions/{sessionId}/turns/active
GET  /api/sessions/{sessionId}/turns/by-client-request?clientRequestId=...
POST /api/sessions/{sessionId}/turns/{turnId}/interrupt
GET  /api/sessions/{sessionId}/items?afterSequence=...
GET  /api/sessions/{sessionId}/events?afterSequence=...
```

Turn 创建接口先在一个事务里写入排队中的 Turn、AgentRun、用户消息和首条 RuntimeEvent，再返回 `202` 并交给后台协调器。协调器取得全局并发名额后才把状态推进为运行中。若 POST 响应结果不确定，客户端会保留原 `clientRequestId`，最多自动重试五次，并按幂等键查询服务端事实；用户可以停止自动确认，最终对账完成前输入区保持锁定，之后的显式重试仍沿用原键，不会把一次发送误执行两遍。客户端通过 SSE 读取持久事件；断线后自动使用最后看到的 sequence 退避重连。切换会话或重载页面时，客户端会先清空旧投影，再通过 active Turn 接口恢复执行状态和中断控制，不依赖旧页面的内存状态。

项目创建接口使用幂等键保护重复提交。会话列表直接返回每个会话的上下文汇总投影，后端通过一次批量查询取得最近一条模型用量事件，避免左侧列表逐会话请求 `/usage`。当前会话接收到 `model_usage` SSE 事件时，输入区与左侧圆形进度会同步更新；输入 Token、输出 Token 和上下文窗口分别保留，不把输出消耗混入输入进度。

模型文本采用真实流式链路：Runtime 收到 Provider 的 `text_delta` 后，在完成单步大小校验后立即交给协调器持久化和 SSE 发布，不等待 Provider 整段结束。前端把“已接收文本”和“可见文本”分离，高频事件每动画帧最多发布一次，再由自适应显示游标平滑追赶；后台窗口用低频计时器兜底。Runtime 终态先保留实时投影，待显示游标追上后再切换到权威持久化消息，避免尾部闪现或丢失。助手正文统一按安全 GFM Markdown 渲染，原始 HTML 不进入 DOM，外部资源协议使用白名单。

## 持久化与恢复

本地状态保存在 SQLite。Alembic 管理 schema 版本；后续迁移只做增量演进，不改写已经发布的历史版本。每条连接启用外键、WAL 和忙等待。数据库唯一约束负责兜底幂等请求、单会话单 Turn、事件顺序、项目根目录位置等关键规则，应用层把约束冲突翻译成稳定 HTTP 语义。`0005` 新增项目、项目根目录、会话目录快照与可空的项目归属，并把旧会话回填成不绑定项目的单根目录任务；项目删除使用 `SET NULL`，不级联删除会话。

客户端只渲染 `session_items` 投影；`runtime_events` 保存更完整的运行事实。二者分开后，未来可以新增思考、工具调用、审批和证据事件，而不迫使会话 UI 直接理解所有内部细节。

## 当前边界与下一期

`ModelAgentRuntime` 已经在同一个端口后实现 Agent Loop、OpenAI/Anthropic 工具协议、内置文件与 PowerShell 工具、并行/独占调度、多根工作区边界、T1/T2 工具账本、持久审批和崩溃恢复。文件工具以会话快照中的全部 `workspace_roots` 为授权边界，并拒绝越界绝对路径和符号链接逃逸。详细语义见 [Agent Loop 与工具执行设计](./AgentLoop与工具执行设计.md)。

上下文管理已实现 Token Budget 换窗、本地 Checkpoint、历史检索与 Artifact，详见 [上下文管理与 Token Budget 设计](./上下文管理与TokenBudget设计.md) 和 [实现审核说明](./上下文管理实现审核说明.md)。换窗复用现有 Session、Turn 和 Run，不重置审批或执行预算。

下一期继续增加上述上下文管理、Skill/MCP 能力快照、模型重试预算、隔离执行和 Eval 数据集。这些能力复用现有 Session、Turn、Run、RuntimeEvent、ToolInvocation 与 ApprovalRequest，不需要推翻客户端会话协议。
