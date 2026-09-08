# Agent Loop 与工具执行设计

## 目标

本期把文本 Runtime 扩展为可实际操作工作区、可审批、可审计和可恢复的生产级 Agent Loop。模型不直接接触操作系统；它只能提交结构化工具调用，由 Runtime 根据 Session 的固定工作区和权限档位执行。

```text
模型步骤 -> 组装工具调用 -> 权限/参数/调度检查 -> T1 -> 审批（按需）
        -> 工具执行 -> T2 -> 结果回填模型 -> 下一模型步骤 -> 最终回答
```

实现参考了两个成熟项目的不同长处：

- [Codex 工具路由与并发门](https://github.com/openai/codex/tree/112be0bd74ce327788613f4f8f92e8b7c92447c7/codex-rs/core/src/tools)：工具声明并行能力，可并行调用真实重叠执行，但结果按模型调用顺序回填；
- [Maka Runtime](https://github.com/apache/maka/tree/2310035a38c1db9f210252a03ce2c741e86ff878/packages/runtime/src)：`exclusive_step`、副作用前后持久事实、恢复语义和重复失败保护。

AI-ME 没有照搬任一框架，而是把这些机制放进自己的 Python 模块化单体边界：应用层定义端口，基础设施层实现模型协议、SQLite 账本和本地工具，`composition.py` 统一装配。

## 模型协议

`ModelGateway` 现在支持四类稳定对象：

- `LlmToolDefinition`：工具名称、说明和 JSON Schema；
- `LlmToolCall`：模型输出的完整调用；
- `LlmAssistantToolCallMessage`：下一模型步骤需要回放的助手调用；
- `LlmToolResultMessage`：工具成功或错误结果。

OpenAI Chat Completions 和 Anthropic Messages 分别完成协议翻译。Anthropic 的同一步多个 `tool_result` 会合并为一条 `user` 消息；OpenAI 使用 `assistant.tool_calls` 和 `tool` 消息。

Runtime 限制单个 Run 最多 32 个模型步骤、单步最多 16 个工具调用、单个工具参数最多 100,000 字符、单步模型文本最多 1,000,000 字符。达到上限会形成用户可见失败，不会无限运行。

## 内置工具

| 工具 | 行为 | 调度语义 | 权限 |
|---|---|---|---|
| `list_files` | 列出目录，可选递归 | `parallel` | 只读及以上 |
| `search_text` | 正则搜索 UTF-8 文本 | `parallel` | 只读及以上 |
| `read_file` | 按可选行范围读取 UTF-8 文件 | `parallel` | 只读及以上 |
| `write_file` | 原子创建或显式覆盖文件 | `exclusive_step` | 工作区可写及以上 |
| `edit_file` | 精确替换，默认拒绝多处匹配 | `exclusive_step` | 工作区可写及以上 |
| `run_powershell` | 在工作区执行非交互 PowerShell | `exclusive_step` | 工作区可写及以上，并需审批 |

所有文件路径必须是相对工作区路径。解析后的真实路径必须仍在工作区内，因此 `..`、绝对路径和符号链接逃逸都会被拒绝。文件写入使用同目录临时文件和原子替换，避免异常退出留下半文件。命令最长运行 120 秒，输出和文件读取都有截断上限。

## 并发和独占

同一模型步骤中的 `parallel` 工具会先逐条提交 T1，再一起启动。它们可以按实际耗时乱序完成，但交给模型的结果始终保持原调用顺序。

`exclusive_step` 必须是该模型步骤中的唯一调用。如果模型把它与读取或另一个独占工具混在一起，Runtime 不执行任何一个调用，而是返回 `exclusive_step_mixed` 工具错误，让模型下一步重新规划。这避免了“模型以为同时发生，Runtime 却悄悄排队”的语义偏差。

等待审批的 Run 会释放进程级 Session 并发名额，不会让两个待审批任务阻塞其他会话。

## 权限和审批

权限采用拒绝优先：

- `read_only`：模型只看得到列出、搜索和读取工具；
- `workspace_write`：增加工作区写入、编辑和 PowerShell；
- `full_access`：保留完全访问语义，但危险、不可逆或外部副作用仍不绕过审批。

当前始终需要审批的操作是 PowerShell；覆盖已有文件、删除匹配文本和批量替换等高影响编辑也需要审批。审批决定有三种：

- `approve_once`：只执行当前调用；
- `approve_session`：当前调用获批，并在同一 Session 内允许后续同名工具；
- `reject`：不执行副作用，把结构化拒绝错误回填模型，使模型可以解释或改换方案。

审批请求首先写入 SQLite，再把 Session、Turn 和 Run 原子切换为 `waiting_for_user`。HTTP 接口提交决定后先持久化，再唤醒 Runtime。

## T1/T2 与恢复

`tool_invocations` 是工具账本：

- T1：`prepared`，保存 Run、步骤、调用顺序、工具、参数、风险和调度语义；
- 开始：`running`；
- T2：`completed` 或 `failed`，保存结构化结果与时间。

`approval_requests` 保存审批事实，`approval_grants` 保存 Session 级同名工具授权。`runtime_events` 继续承担有序重放，工具账本承担精确审计和恢复，两者职责不同。

恢复规则：

| 崩溃位置 | 恢复行为 |
|---|---|
| 等待审批 | 重启后恢复原 Run、原调用和原审批，不重新请求模型生成调用 |
| T1 后、工具尚未开始 | 从原调用继续执行 |
| T2 后、下一模型步骤前 | 复用已保存结果继续模型循环，不重放工具 |
| `running` 后、T2 前 | 标记为结果不确定并生成审批；用户明确批准才重试，拒绝则作为工具错误继续 |
| 尚无任何工具事实的遗留 Run | 沿用会话底座规则，收敛为 `interrupted` |

这一设计不声称能够推断外部副作用是否发生；它把无法证明的状态显式暴露给用户，避免静默重复执行。

## HTTP 与客户端

新增接口：

```text
GET  /api/sessions/{sessionId}/approvals
POST /api/sessions/{sessionId}/approvals/{approvalId}/decision
GET  /api/sessions/{sessionId}/tool-invocations
```

客户端在用户消息下方展示工具名称、关键参数和状态。待审批时显示原因、完整参数和“拒绝 / 仅本次允许 / 本会话允许”。页面刷新后会从持久账本恢复工具轨迹和审批，不依赖浏览器内存。

## 下一阶段边界

本期工具来源仍是内置注册表。下一阶段可以在不改变 Agent Loop 主协议的前提下加入：

- Skill 能力快照和提示词装配；
- MCP Server 发现、生命周期和工具适配；
- 上下文压缩与 token 预算；
- 更细的 PowerShell 命令策略、网络策略和隔离执行；
- Tool/Turn Eval 数据集、质量指标和回归门禁。
