# 项目与 Skill 集成 CR 指南

## 本地合并边界

用户授权合并到本地 `main`，未推送远端。原功能分支、原提交和上下文工作区未提交内容均保留，不 squash、不重写原历史。

| 内容 | 审核入口 |
| --- | --- |
| 合并前 AI-ME 主线 | `d6e7084` |
| ZCode 原版客户端、本地模型/窗控/文件差异保全提交 | `0b96f6b` |
| 原有设计文档保全提交 | `24359b1`（分支 `codex/zcode-workbench-integration`） |
| Skill/上下文原实现 | `27706a6` 与 `761d464`（分支 `codex/skill-runtime`） |
| ZCode 本地合并 | `9801c03` |
| Skill/上下文非 squash 合并 | `27145e9` |
| 本次项目/技能/上下文展示兼容补丁 | `codex/project-skills-compatibility` 相对 `27145e9` 的差异 |

`codex/context-token-budget` 在独立工作区仍有暂存和未暂存的旧上下文实现，没有擅自提交或覆盖。Skill 分支已包含这部分已提交实现及后续修复，不能把旧工作区再覆盖到新实现上。旧 `frontend/src/App.tsx`、`SkillLibrary.tsx` 等保留用于 CR；实际入口是 `frontend/src/workbench/main.jsx`。

可用 `git diff d6e7084..761d464 -- backend` 看原功能；用 `git diff 27145e9..codex/project-skills-compatibility` 看接入补丁；用 `git show 24359b1:docs/上下文管理与TokenBudget设计.md` 看原始设计稿。

## 领域语义

1. ZCode 的 `workspacePath` 在宿主边界可作为逻辑主键。项目地址为 `ai-me-project://<projectId>`，仅用于 UI 分组/订阅/草稿隔离，不是文件系统路径，也不标记为远程工作区。
2. 首发提交真实 `projectId`；AI-ME 后端解析当前主目录和全部授权根，建立会话快照。既有会话按服务端 `projectId` 分组，不按当前项目目录猜测。
3. 项目可以共享目录；独立会话的 `projectId=null`，即使同目录也不混入项目。删除项目保留会话和文件，后端解除归属。
4. Skill 目录以项目 ID 或会话 ID 为边界；API 不允许传任意路径扩大扫描。已有会话使用自身目录快照，项目设置修改只影响新会话。
5. Skill 正文在运行时按需加载。前端不把整个技能库作为正文拼入请求，引用精确转换为 `/skill:ref`。启停/固定仍是 AI-ME 原有偏好存储。
6. 上下文合并包含预算、维护、换窗、检查点与历史/产物检索。手动 `/compact`、插件安装和 Skill 文件导入/删除不在现有后端合同内，不能伪装完成。

## 验收证据

- 前端 72 项通过，包含真实协议首发的 `projectId` 断言、同路径两个项目与独立会话隔离、Windows 大小写/斜杠规范化、原版 Skill 过滤和 Markdown 引用、越权/已失效引用拒绝、偏好保留。
- 后端全量基线 149 通过、1 跳过；新增项目 Skill API 验证 ID 权限边界与多根解析。之后新增大差异回归和用量估算修复采用受影响用例重跑，大小差异两项均通过。
- 真实 Electron + 独立后端验收脚本验证名称、多根快照、改主目录、新会话归属、删除解绑、Skill 正文进入模型请求、启停/固定、重载及自绘窗控。模型为确定性替身，不声称验证了模型生成质量或外部厂商网络。
- 构建为实际 `/app/` 生产资源；截图使用相同组件和桌面壳，不是静态效果图。

复验命令：frontend 执行 `npm test -- --reporter=dot`、`npm run build`；backend 执行 `python -m pytest`；desktop 构建后执行 `npm run test:project-skills`。桌面验收需 Playwright，Windows 可将 `AI_ME_PLAYWRIGHT_MODULE` 指向已安装模块的 `index.mjs`。

验收目录自动放在仓库忽略的 `tmp/project-skills-*` 下，截图在 `output/playwright/`；这些不是用户项目数据，不提交到版本库。账号购买链路移除与上游版权声明保持不变。

## 本机状态保护

升级前已比较运行中 API 与状态库的会话 ID 集合：4 个会话、0 个活动执行。使用 SQLite 在线备份 API 生成一致性备份，`integrity_check=ok`，原版本为 `0005_projects_and_session_roots`；另保留原 artifacts 目录。

本机备份位置：`C:/Users/XT-SJ01/AppData/Local/AI-ME/backups/zcode-skill-20260921-1410/`。恢复属于显式回退操作，必须先停止客户端/后端、再保全升级后数据后使用备份，不可用旧版本程序直接覆盖新库。
