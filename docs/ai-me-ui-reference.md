# AI-Me UI 参考稿

本文档收录 AI-Me v0.1 的 9 张 UI 参考稿。原图为 2K 设计稿，由 GPT 生成，统一放在
`docs/assets/ai-me-ui/`。这些图片只代表产品方向，不等同于最终生产界面。

## 页面清单

| 序号 | 页面 | 参考图 |
| --- | --- | --- |
| 1 | 工作驾驶舱 / Dashboard | [01-dashboard.png](assets/ai-me-ui/01-dashboard.png) |
| 2 | 工作看板 / Board | [02-board.png](assets/ai-me-ui/02-board.png) |
| 3 | 例外收件箱 / Exceptions | [03-exceptions.png](assets/ai-me-ui/03-exceptions.png) |
| 4 | 审批中心 / Approvals | [04-approvals.png](assets/ai-me-ui/04-approvals.png) |
| 5 | 对话与线程 / Threads | [05-threads.png](assets/ai-me-ui/05-threads.png) |
| 6 | 记忆与知识 / Memory | [06-memory.png](assets/ai-me-ui/06-memory.png) |
| 7 | AI 员工 / Agents | [07-agents.png](assets/ai-me-ui/07-agents.png) |
| 8 | 工具与权限 / Tools & Permissions | [08-tools-permissions.png](assets/ai-me-ui/08-tools-permissions.png) |
| 9 | 设置 / Settings | [09-settings.png](assets/ai-me-ui/09-settings.png) |

## 落地备注

- 这些稿件先作为产品方向参考，不直接等同于最终组件规格。
- 继续遵守当前包边界：共享页面放在 `packages/views/`，无头状态和 API 放在 `packages/core/`，应用路由留在各自 platform 层。
- 优先复用现有 issue、inbox、agent、runtime、activity 数据，再补 AI-Me 专属 sidecar 表。
- 对外动作必须保留审批门。驾驶舱第一屏应优先突出“需要 Owner 介入”，而不是单纯堆任务数量。
