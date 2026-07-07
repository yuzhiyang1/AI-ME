# AI-ME 本地演示数据

这份文档用于快速启动 AI-ME 的本地演示基线。它不会写入 LLM API key，也不会读取真实外部系统，只会向本地 PostgreSQL 写入一组可重复的 demo 数据。

## 使用方式

先确保本地数据库已经启动并完成迁移：

```bash
make migrate-up
```

如果你的 Windows 环境没有 `make`，可以先用现有本地启动流程完成数据库和迁移。

然后写入 AI-ME demo 数据并做烟测：

```bash
pnpm aime:demo
```

也可以拆开执行：

```bash
pnpm aime:seed
pnpm aime:smoke
```

脚本默认读取 `.env`；如果你要指定其他环境文件：

```bash
ENV_FILE=.env.worktree pnpm aime:demo
```

## 会创建什么

脚本会创建或刷新一个 `ai-me-demo` 工作区，并写入：

- AI-ME 演示工作区；
- 当前数据库里已有用户的 workspace member 关系；
- 如果数据库里还没有用户，则创建 `owner@ai-me.local` 演示用户；
- `Codex Worker #1` 和 `Claude Worker #1` 两个 AI 员工；
- 三条 issue：退款回复、接口响应时间、候选记忆确认；
- 一条 queued、running、completed 的员工任务样例；
- 两条例外收件箱消息；
- 三条待审批事项：分配员工、对外回复、确认记忆；
- 已确认记忆、候选记忆、证据来源和知识文档。

重复运行脚本是幂等的：同一组 demo 数据会被刷新，不会无限堆叠重复记录。

## 安全边界

为了避免误写远端数据库，脚本默认只允许连接本地 PostgreSQL：

- `localhost`
- `127.0.0.1`
- `::1`

如果你确实要写远端测试库，需要显式设置：

```bash
AI_ME_ALLOW_REMOTE_SEED=true pnpm aime:demo
```

不建议对生产库使用这个开关。

## 本地查看路径

启动 Web 服务后，可以在工作区中查看：

```text
/ai-me-demo/dashboard
/ai-me-demo/approvals
/ai-me-demo/inbox
/ai-me-demo/memory
/ai-me-demo/agents
```

这组数据的目标不是伪造最终产品效果，而是提供一个稳定的最小闭环测试基线：驾驶舱、审批中心、例外收件箱、记忆与 AI 员工调度都能看到真实数据库记录。
