# AI-ME 飞书狗粮测试与发布形态收口

这份文档用于收口 AI-ME 当前阶段的真实飞书狗粮测试、可靠性、安全边界、成本控制和发布形态。它面向开发和自托管验证，不代表生产可用承诺。

## 当前定位

AI-ME 现在仍是开发阶段的个人工作驾驶舱。推荐先按本地优先、自托管优先的方式跑通闭环：

```text
飞书消息
-> AI-ME webhook
-> 例外收件箱
-> AI 回复草稿
-> 人工审批
-> 飞书机器人回复
-> 质量评分 / 成本记录 / 轨迹审计
```

Codex、Claude Code 等高成本工具继续作为可调度员工。AI-ME 自己通过 OpenAI-compatible LLM API 做判断、草稿和路由，默认优先接入 DeepSeek 这类成本更可控的模型。

## 七项收口范围

| 项目 | 当前验收口径 |
| --- | --- |
| 真实飞书狗粮测试 | 面板提供 20 个真实消息验收槽位；完成发送或驳回并做质量复盘后才计入完成 |
| 飞书可靠性补强 | 入站事件记录签名、token、重放保护、重复事件和终态；出站发送支持自动重试、死信隔离和人工恢复 |
| 决策质量评估 | AI 回复审批支持评分，飞书面板展示平均分、低分数和已复盘数量 |
| 成本与模型路由 | 面板展示当前模型、预算、预估草稿成本和预算状态 |
| 首次使用流程 | onboarding checklist 覆盖 LLM、员工、飞书入站、签名、出站、审批、发送、复盘、预算和 20 条狗粮 |
| 权限与安全收口 | 飞书入站限制 chat / sender，出站必须审批；敏感配置只走环境变量 |
| 发布形态整理 | README 与本文件明确 AI-ME 仍在开发阶段，适合本地和自托管验证 |

## 环境变量

敏感值只能放在本地 `.env` 或部署环境变量里，不要提交到仓库。

### LLM 与预算

| 变量 | 说明 |
| --- | --- |
| `AI_ME_LLM_PROVIDER` | LLM provider 名称，例如 `deepseek` |
| `AI_ME_LLM_MODEL` | AI-ME 草稿和判断使用的模型，DeepSeek 默认使用 `deepseek-v4-flash` |
| `AI_ME_LLM_API_KEY` | OpenAI-compatible API key |
| `DEEPSEEK_API_KEY` | DeepSeek key，可作为本地便捷配置 |
| `AI_ME_DAILY_BUDGET_CENTS` | 每日预算上限，单位为 cents；明确配置后才启用预算阻断 |
| `AI_ME_LLM_DRAFT_COST_CENTS` | Provider 未返回 Token usage 时的单次草稿兼容估值 |
| `AI_ME_LLM_INPUT_PRICE_PER_MILLION_USD` | 可选，覆盖每百万未缓存输入 Token 单价 |
| `AI_ME_LLM_CACHE_READ_PRICE_PER_MILLION_USD` | 可选，覆盖每百万缓存命中 Token 单价 |
| `AI_ME_LLM_OUTPUT_PRICE_PER_MILLION_USD` | 可选，覆盖每百万输出 Token 单价 |

DeepSeek 草稿会优先使用 API 返回的 Token usage 计算逐条成本；每日预算只统计当天调用，不再把历史累计成本误算进今日预算。内置价格以 DeepSeek 官方模型价格为基准，也可以通过上述变量覆盖。

### 飞书入站

| 变量 | 说明 |
| --- | --- |
| `FEISHU_EVENT_MODE` | 推荐设为 `webhook` |
| `FEISHU_WEBHOOK_TOKEN` | 飞书事件订阅 token |
| `FEISHU_ENCRYPT_KEY` | 飞书事件订阅 Encrypt Key，用于签名校验、AES-256-CBC 解密和重放保护 |
| `AI_ME_FEISHU_DRAFT_TIMEOUT_MS` | 入站回复草稿的模型等待上限，默认 1200ms；超时后使用保守草稿继续落库 |
| `FEISHU_WORKSPACE_ID` | 飞书消息进入的 AI-ME workspace UUID |
| `FEISHU_WORKSPACE_SLUG` | 未配置 UUID 时可用 workspace slug 解析 |
| `FEISHU_OWNER_USER_ID` | 默认 owner，用于创建收件箱 item 和审批 |
| `FEISHU_ALLOWED_CHAT_ID` | 限制只接收指定 chat 的消息 |
| `FEISHU_ALLOWED_OPEN_ID` | 限制允许的发送人 open_id，逗号分隔 |
| `FEISHU_ALLOWED_USER_ID` | 限制允许的发送人 user_id，逗号分隔 |
| `FEISHU_ALLOWED_UNION_ID` | 限制允许的发送人 union_id，逗号分隔 |
| `FEISHU_GROUP_MESSAGE_POLICY` | 群消息策略，建议先用提及或白名单策略 |

### 飞书出站

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` | 飞书机器人 app id |
| `FEISHU_APP_SECRET` | 飞书机器人 app secret |
| `AI_ME_FEISHU_SEND_MAX_ATTEMPTS` | 出站发送最大尝试次数，默认 3 |
| `AI_ME_FEISHU_RETRY_AFTER_SECONDS` | 失败后的自动重试间隔，默认 300 秒 |
| `AI_ME_FEISHU_RETRY_POLL_SECONDS` | 后台扫描到期发送记录的间隔，默认 15 秒 |
| `AI_ME_FEISHU_RETRY_BATCH_SIZE` | 每轮最多处理的发送记录，默认 20 |
| `AI_ME_FEISHU_SENDING_LEASE_SECONDS` | `sending` 状态的抢占租约，超时后允许恢复，默认 60 秒 |

## 安全边界

飞书 webhook 需要配置 `FEISHU_ENCRYPT_KEY`。AI-ME 按[飞书官方 Encrypt Key 加密说明](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case)处理事件：先使用 `timestamp + nonce + encrypt_key + body` 计算 SHA256 并校验请求签名，再对加密信封执行 AES-256-CBC 解密，最后校验 Verification Token。项目同时会拒绝时间戳超出窗口的请求，降低重放风险。

飞书回复使用审批 ID 作为稳定 `uuid`。按[飞书官方回复消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN)的去重规则，相同 `uuid` 的请求在 1 小时内最多成功回复一次，避免网络超时后的自动重试生成重复消息。

当前必须保留这些边界：

- 飞书对外回复必须先进入审批，不能绕过人工确认。
- 未配置签名时，面板会提示飞书安全项未完成。
- 入站事件要经过签名、解密、token、重放窗口、chat / sender 白名单检查。
- Webhook 处理不继承客户端断连；模型超时不能阻止收件箱和审批落库，明确失败的事件允许飞书重试重新消费。
- 出站发送失败要记录原因、尝试次数和下一次可重试时间；到期后由后台自动重试。
- 达到最大尝试次数后进入死信，不再自动发送，只能从狗粮面板或审批中心人工恢复。
- LLM API key、飞书 app secret、webhook token、encrypt key 都不能提交到仓库。
- 真实狗粮测试阶段先不要接 GitHub、邮箱、日历，避免扩大输入面。

## 真实狗粮测试流程

1. 启动本地后端和前端，确保 `.env` 已配置 LLM、飞书入站、飞书出站和预算变量。
2. 使用本机公网或内网穿透地址，把飞书事件订阅回调指向 AI-ME webhook。
3. 在飞书发送一条真实消息，确认 AI-ME 例外收件箱生成 item，并产生 AI 回复审批。
4. 在审批中心编辑或确认回复内容，批准发送。
5. 确认飞书原消息收到机器人回复。
6. 在飞书狗粮测试面板查看入站事件、发送记录、质量评分、成本与 checklist。
7. 连续处理 20 条真实工作消息，在面板逐条完成审批、发送或驳回、质量复盘。

## 验收标准

第一个可用里程碑不是“功能都看起来存在”，而是能连续处理真实工作信号：

- 至少 20 条真实飞书消息进入 AI-ME，并在 20 个验收槽位中完成闭环。
- 每条消息有入站事件记录，重复事件不会重复创建工作项。
- 需要对外回复的消息都进入审批。
- 批准后的发送结果可追踪；失败会自动重试，超过上限进入死信并支持人工恢复。
- 20 条消息都完成质量复盘，面板能看到平均分、低分样本数和每条阻塞原因。
- 面板能看到模型、预算、成本和安全 checklist。
- README、配置说明和本文件足够让下一次本地验证复现。

## 后续暂缓

这些能力暂时不作为本轮收口目标：

- GitHub 真实集成扩展
- 邮箱入口
- 日历入口
- Slack、Jira、Linear 等外部系统
- 云端多租户生产部署

等飞书真实狗粮测试稳定后，再按真实使用频率推进下一类入口。
