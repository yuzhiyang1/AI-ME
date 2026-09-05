# Agent 会话与 Runtime 设计

## 目标

第一期先交付一条真正可用、可恢复的本地 Agent 会话链路：用户为会话选择固定工作区和默认模型，连续发送多个 Turn，AI-ME 通过自研 `AgentRuntime` 端口调用模型，并把用户消息、运行事实与最终回答持久化到本机。

这条切片解决“能不能稳定地开始对话、继续对话、重启后找回对话”的问题。工具循环、Skill、MCP 和审批会在这个底座之上继续扩展，不需要推翻会话协议。

## 三层对象

客户端只需要理解三个对象：

- `Session`：一段可长期继续的任务会话，固定绑定工作区、模型和权限档位；
- `Turn`：用户的一次输入以及由它触发的 Agent 工作；
- `Item`：时间线中稳定可渲染的用户消息、Agent 消息或错误。

Runtime 内部保留更精细的对象：

- `AgentRun`：同一 Turn 的一次具体执行尝试；
- `RuntimeEvent`：运行过程中不可变、有序、可按 sequence 重放的事实；
- 后续的 `ToolInvocation`、`ApprovalRequest` 和 `Checkpoint`。

这样可以让客户端协议保持简单，同时为失败恢复、重试、工具审计和 Eval 留出足够精度。

## 核心不变量

- 一个 Session 固定绑定一个已经存在的本地目录；
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

## 持久化与恢复

本地状态保存在 SQLite。Alembic 管理 schema 版本；`0002` 以增量迁移兼容已经执行过 `0001` 的本地库，不改写历史版本。每条连接启用外键、WAL 和忙等待。数据库唯一约束负责兜底幂等请求、单会话单活跃 Turn、事件顺序等关键规则，应用层把约束冲突翻译成稳定 HTTP 语义。早期未版本化预览库只有在完整字段签名、唯一约束、级联外键、已有数据完整性和活跃 Turn 部分唯一索引全部匹配时才会被纳入迁移，避免把半残状态库错误盖章为可用。

客户端只渲染 `session_items` 投影；`runtime_events` 保存更完整的运行事实。二者分开后，未来可以新增思考、工具调用、审批和证据事件，而不迫使会话 UI 直接理解所有内部细节。

## 当前边界与下一期

当前 `ModelAgentRuntime` 是文本版 Runtime，实现多轮模型调用、流式文本事件、错误收敛、中断和恢复。下一期在同一个 `AgentRuntime` 端口后增加：

1. 工具注册表与模型工具协议；
2. 工作区路径沙箱、命令策略和输出上限；
3. `ToolInvocation` 账本、危险操作审批和幂等键；
4. Skill/MCP 适配与能力快照；
5. checkpoint、重试策略、context 压缩与 Eval 数据集。

这些属于生产级 Agent 的后续核心能力；当前切片是它们共同依赖的会话与执行账本，而不是一个临时聊天 Demo。
