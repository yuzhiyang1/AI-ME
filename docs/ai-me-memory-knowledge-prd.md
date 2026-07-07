# AI-Me 记忆与知识模块 PRD

## 背景

AI-Me 的目标不是再做一个聊天窗口，而是成为用户的工作驾驶舱和工作代理层。要做到这一点，AI-Me 需要长期、可追溯、可治理地理解用户和项目：用户是谁，偏好什么，哪些判断规则必须遵守，项目事实来自哪里，哪些经验已经被验证，哪些内容只能内部使用。

当前 Multica 已经有工作区、Issue、Agent、Agent Runtime、Skill、Activity Log、Chat、Attachment 等基础数据结构，但还没有一个专门承载 AI-Me 长期记忆与项目知识的治理模型。Skill 更像给 AI 员工执行任务的 SOP/playbook；记忆与知识则是 AI-Me 在接管工作、判断风险、生成回复、调度 Codex / Claude Code 员工时使用的事实和偏好资产。

## 问题陈述

用户不希望每次都从零解释自己是谁、项目怎么做、沟通风格是什么、哪些事情可以自动做、哪些事情必须先确认。用户也不希望 AI-Me 擅自记住错误信息，或把内部经验直接用于对外表达。

因此，AI-Me 需要一个可视化的“记忆与知识”模块，让用户能看到、确认、编辑、归档、验证、限制和追溯 AI-Me 正在使用的长期上下文。

## 目标

- 展示 AI-Me 已确认的个人记忆、项目知识、流程规则、历史经验和数据来源。
- 区分已确认记忆、候选记忆、已归档记忆和低置信度记忆。
- 每条记忆都必须有类型、来源、置信度、适用范围、时间戳和外部使用权限。
- AI-Me 从任务、对话、邮件、飞书、GitHub、Issue、Agent 运行中推断出的新记忆，默认进入候选区，需要用户确认后才能成为长期记忆。
- 为后续 AI-Me 直连 LLM API 提供可靠的上下文检索基础。
- 为 Codex / Claude Code 等 AI 员工提供受控上下文，而不是把所有历史内容无差别塞进 prompt。

## 非目标

- v0.1 不做完整企业知识库替代品。
- v0.1 不做向量数据库可视化，也不把页面做成 chunk 列表。
- v0.1 不让 AI-Me 自动把推断内容写入长期有效记忆。
- v0.1 不把 Skill 和 Memory 合并。Skill 是执行方法，Memory 是事实、偏好和经验。
- v0.1 不做复杂权限矩阵，先支持工作区、个人、项目、Agent 可用范围。

## 核心概念

### 记忆

AI-Me 可长期复用的结构化上下文。它可以来自用户手动创建、用户确认的候选记忆、项目文档提取、历史任务总结或外部系统事件。

### 知识

项目事实、文档、规则、流程、系统说明、接口约定、SOP 和外部资料。知识可以被提炼为记忆，也可以作为证据来源存在。

### 候选记忆

AI-Me 从上下文中推断出的可能有价值内容。候选记忆不能直接用于长期个性化和对外表达，必须经过用户确认、编辑或忽略。

### 证据

支撑某条记忆的原始来源，例如 Issue、评论、对话、Activity Log、PR、提交、日志、飞书消息、邮件、导入文档或用户手动输入。

### 适用范围

控制记忆在哪些场景可用。基础范围包括：

- 个人级：只影响当前用户。
- 工作区级：影响整个 workspace。
- 项目级：仅影响特定项目或代码库。
- Agent 级：仅给指定 AI 员工使用。

### 外部使用权限

控制记忆是否可以用于对外回复、邮件、飞书消息或客户沟通。默认不允许对外表达，除非用户明确打开。

## 用户故事

1. 作为 AI-Me 用户，我想看到 AI-Me 已经记住了什么，以便判断它是否真的理解我和项目。
2. 作为 AI-Me 用户，我想确认或忽略候选记忆，以免错误推断污染长期上下文。
3. 作为 AI-Me 用户，我想编辑记忆内容，以便把模糊经验改成清晰规则。
4. 作为 AI-Me 用户，我想看到每条记忆的来源，以便知道 AI-Me 为什么相信它。
5. 作为 AI-Me 用户，我想设置记忆是否可用于对外表达，以免内部判断被错误发给外部对象。
6. 作为 AI-Me 用户，我想按类型筛选记忆，以便快速找到沟通风格、工作习惯、项目知识和判断规则。
7. 作为 AI-Me 用户，我想看到低置信度和可能过期的记忆，以便定期清理。
8. 作为 AI-Me 用户，我想知道某条记忆最近被使用过几次，以便判断它是否仍然有价值。
9. 作为 AI-Me 用户，我想归档不再适用的记忆，以便保留历史但不再影响 AI-Me。
10. 作为 AI-Me 用户，我想导入项目资料，以便 AI-Me 能从真实文档中建立项目知识。
11. 作为 AI-Me 用户，我想知道某条知识来自哪个数据源，以便回到原文核对。
12. 作为 AI-Me 用户，我想限制某些记忆只能给 Codex 或 Claude Code 使用，以便控制上下文暴露。
13. 作为 AI-Me 用户，我想在 AI-Me 做出重要建议时看到它用了哪些记忆，以便审查它的判断链路。
14. 作为 AI-Me 用户，我想把某条历史经验升级成判断规则，以便未来类似场景自动遵守。
15. 作为 AI-Me 用户，我想把错误记忆标记为不可信，以便 AI-Me 下次不要继续引用。

## 产品结构

### 固定导航入口

导航名称：`记忆与知识`

建议路径：

- Web：`/:workspaceSlug/memory`
- Desktop：工作区内 tab route `memory`

### 页面 Tabs

v0.1 页面使用以下 Tabs：

- `个人记忆`
- `项目知识`
- `文档`
- `规则与流程`
- `待确认记忆`
- `数据来源`

与 06-memory 设计稿保持一致，但文案以产品语义为准，不照搬图片中可能不稳定的示例文本。

### 页面布局

- 顶部：标题、说明、搜索、导入资料、新建记忆。
- 左侧：分类与状态统计。
- 中间：记忆或知识列表。
- 右侧：详情、来源、适用范围、使用历史和操作区。

### 记忆列表字段

- 内容摘要。
- 类型。
- 来源。
- 置信度。
- 适用范围。
- 最近验证时间。
- 最近使用时间。
- 是否允许对外表达。
- 状态：候选、已确认、低置信度、可能过期、已归档。

### 详情区字段

- 完整内容。
- 类型与分类。
- 置信度。
- 敏感级别。
- 适用范围。
- 可用对象：AI-Me、指定 Agent、指定项目。
- 外部使用权限。
- 创建方式。
- 创建时间、更新时间、最近验证时间、过期时间。
- 证据来源列表。
- 适用示例。
- 避免使用的场景。
- 使用历史。

### 候选记忆动作

- `确认`：进入已确认记忆，可被检索使用。
- `编辑后确认`：先修改内容、范围、权限、类型，再确认。
- `忽略`：不进入长期记忆，并记录忽略原因。

候选记忆不能默认对外表达，也不能默认进入 AI-Me 长期上下文。

## 页面契约

```text
User goal:
让用户理解、治理并修正 AI-Me 的长期上下文。

Primary information:
已确认记忆、项目知识、候选记忆、来源、置信度、适用范围和外部使用权限。

Primary action:
对候选记忆执行确认、编辑后确认或忽略。

Secondary actions:
搜索、筛选、新建记忆、导入资料、编辑、归档、标记已验证、限制对外表达。

Required states:
loading、empty、populated、recoverable error、permission denied、disconnected/offline。

Evidence shown:
原始消息、Issue、评论、Activity Log、文档、PR、提交、日志、集成系统事件。

Risk/approval behavior:
低置信度、缺少来源、对外表达权限、过期记忆和冲突记忆必须显式展示。

Responsive behavior:
1440px 使用三栏；1280px 保留三栏但压缩左侧分类；更窄视口可把详情变为抽屉。
```

## 数据模型草案

### memory_entry

承载一条可治理记忆。

字段建议：

- `id`
- `workspace_id`
- `owner_user_id`
- `project_id`
- `type`
- `category`
- `title`
- `content`
- `summary`
- `status`
- `confidence`
- `sensitivity`
- `scope_type`
- `scope_ref_id`
- `external_use_policy`
- `source_mode`
- `created_by_type`
- `created_by_id`
- `verified_by`
- `verified_at`
- `last_used_at`
- `expires_at`
- `archived_at`
- `created_at`
- `updated_at`

枚举建议：

- `type`：`identity`、`preference`、`rule`、`project_fact`、`process`、`history`、`relationship`、`technical_context`
- `status`：`candidate`、`active`、`rejected`、`archived`
- `sensitivity`：`normal`、`private`、`restricted`
- `scope_type`：`user`、`workspace`、`project`、`agent`
- `external_use_policy`：`never`、`with_approval`、`allowed`
- `source_mode`：`manual`、`inferred`、`imported`、`integration`

### memory_source

承载来源对象，避免把来源信息散落在记忆内容里。

字段建议：

- `id`
- `workspace_id`
- `source_type`
- `source_ref_id`
- `source_url`
- `title`
- `excerpt`
- `metadata`
- `captured_at`
- `created_at`

`source_type` 示例：

- `manual_note`
- `issue`
- `comment`
- `chat_message`
- `activity_log`
- `task_message`
- `attachment`
- `skill`
- `project_resource`
- `feishu_message`
- `email`
- `github_pr`
- `imported_document`

### memory_evidence

一条记忆可以有多条证据。

字段建议：

- `id`
- `memory_id`
- `source_id`
- `excerpt`
- `location`
- `confidence`
- `created_at`

### memory_usage

记录记忆被 AI-Me 或 Agent 使用的历史。

字段建议：

- `id`
- `workspace_id`
- `memory_id`
- `used_by_type`
- `used_by_id`
- `issue_id`
- `task_queue_id`
- `chat_session_id`
- `action`
- `outcome`
- `created_at`

用途：

- 详情区展示使用历史。
- 后续评估记忆是否有效。
- 用户追查 AI-Me 为什么做出某个判断。

### knowledge_document

承载导入资料及提取状态。文档内容本身可复用现有 attachment / local storage 能力，表里保存结构化元数据。

字段建议：

- `id`
- `workspace_id`
- `title`
- `source_type`
- `source_url`
- `attachment_id`
- `status`
- `imported_by`
- `metadata`
- `last_indexed_at`
- `created_at`
- `updated_at`

`status` 示例：

- `queued`
- `processing`
- `ready`
- `failed`
- `archived`

## API 合同草案

### 记忆

- `GET /api/memory`
  - 支持 `workspace_id`、`status`、`type`、`category`、`q`、`scope_type`、`limit`、`offset`
  - 返回列表摘要，不返回过大的证据全文。

- `GET /api/memory/{id}`
  - 返回详情、证据来源、使用历史摘要。

- `POST /api/memory`
  - 用户手动创建记忆。
  - 默认 `status=active`，但必须有 `source_mode=manual`。

- `PATCH /api/memory/{id}`
  - 编辑内容、类型、范围、外部使用权限、置信度和状态。

- `POST /api/memory/{id}/archive`
  - 归档记忆，不再参与检索。

- `POST /api/memory/{id}/verify`
  - 标记已验证，写入 `verified_by` 和 `verified_at`。

### 候选记忆

- `POST /api/memory/{id}/confirm`
  - 候选记忆变为 active。

- `POST /api/memory/{id}/confirm-with-edit`
  - 编辑后确认。

- `POST /api/memory/{id}/reject`
  - 标记 rejected，记录原因。

### 知识资料

- `GET /api/knowledge-documents`
- `POST /api/knowledge-documents`
- `GET /api/knowledge-documents/{id}`
- `POST /api/knowledge-documents/{id}/reindex`
- `POST /api/knowledge-documents/{id}/archive`

### 内部检索

- `POST /api/memory/retrieve`

仅供服务端或受控内部调用。输入任务上下文、用户、项目、Agent 和外部表达场景，返回可用于 LLM prompt 的记忆集合。需要按状态、范围、置信度、敏感级别和外部使用权限过滤。

## 前端模块边界

### packages/core

新增建议：

- `memory/types.ts`
- `memory/queries.ts`
- `memory/mutations.ts`

职责：

- React Query 管理服务端状态。
- 提供记忆列表、详情、候选确认、编辑、归档、验证、导入资料等 hooks。
- API 响应使用 schema 解析和 fallback，避免后端字段漂移导致白屏。

### packages/views

新增建议：

- `memory/components/memory-page.tsx`
- `memory/components/memory-list.tsx`
- `memory/components/memory-detail-panel.tsx`
- `memory/components/memory-category-rail.tsx`
- `memory/components/candidate-actions.tsx`
- `memory/index.ts`

职责：

- 渲染 AI-Me 记忆与知识页面。
- 不直接依赖 Next.js 或 React Router。
- 使用 NavigationAdapter 做跳转。
- 空态、加载、错误、离线、无权限状态完整。

### apps/web

新增 workspace route：

- `apps/web/app/[workspaceSlug]/(dashboard)/memory/page.tsx`

### apps/desktop

新增工作区 tab route：

- `memory`

## 复用地图

Reuse unchanged:

- Workspace 路由、DashboardGuard、NavigationAdapter。
- React Query 服务端状态管理方式。
- API client、schema fallback 机制。
- Activity Log、Issue、Comment、Chat、Attachment、Skill 作为证据来源。
- 现有 shared layout、button、badge、tabs、table/list、empty/error patterns。

Extend:

- Sidebar navigation 增加 `记忆与知识`。
- API client 增加 memory / knowledge-document endpoints。
- Realtime invalidation 增加 memory 相关事件。
- Activity Log 增加 memory confirmed / rejected / archived / used 等事件。

New AI-Me component required:

- 记忆分类栏。
- 记忆详情与证据面板。
- 候选记忆治理动作。
- 外部使用权限标识。
- 记忆使用历史摘要。

## 检索与写入规则

### 写入规则

- 用户手动创建的记忆可以直接进入 active。
- AI-Me 推断出的记忆必须进入 candidate。
- 导入文档提取出的事实默认进入 candidate，除非明确作为项目资料展示，而非长期记忆。
- 没有来源的自动记忆不得进入 active。
- 低置信度记忆不得对外表达。

### 检索规则

检索时必须过滤：

- workspace 权限。
- scope 是否匹配当前用户、项目或 Agent。
- status 是否为 active。
- 是否已归档或过期。
- sensitivity 是否允许当前调用方使用。
- external_use_policy 是否允许当前场景使用。
- confidence 是否满足阈值。

### 对外表达规则

当 AI-Me 生成邮件、飞书、客户回复或公开评论时：

- `external_use_policy=never` 的记忆不能进入 prompt。
- `external_use_policy=with_approval` 的记忆可以用于内部草稿，但最终发送需要审批。
- `external_use_policy=allowed` 仍然必须保留证据可追溯。

## 状态设计

### Empty

首次进入时展示：

- 手动新建记忆。
- 导入项目资料。
- 等待 AI-Me 从工作中产生候选记忆。

### Loading

列表和详情分别加载，详情区不要阻塞整个页面。

### Error

列表错误时提供重试；详情错误时保留列表选择状态。

### Permission denied

当用户不是 workspace 成员或没有管理记忆权限时，不展示内容列表。

### Disconnected/offline

允许浏览已缓存列表，但所有写操作置灰并说明需要重新连接。

## 测试策略

### 后端

- 记忆 CRUD 权限测试。
- 候选记忆确认、编辑后确认、忽略状态流转测试。
- workspace 隔离测试。
- 外部使用权限过滤测试。
- 证据来源关联测试。

### Core

- API schema fallback 测试。
- React Query key 按 workspace 隔离测试。
- mutations 的 optimistic update 或 invalidate 行为测试。

### Views

- populated / empty / loading / error / permission denied 状态测试。
- 候选记忆按钮行为测试。
- 详情面板展示来源、置信度、外部使用权限测试。
- 搜索和筛选交互测试。

### E2E

- 创建记忆后列表出现。
- 候选记忆确认后进入已确认列表。
- 归档后不再出现在默认 active 列表。
- 导入资料后出现数据来源记录。

## 分阶段交付

### Phase 1：真实数据骨架

- 新增 DB 表和 sqlc queries。
- 新增 API endpoints。
- 新增 core hooks。
- 前端页面使用真实 API，先覆盖列表、详情、候选确认、编辑、忽略、归档。

### Phase 2：资料导入与证据

- 接入 attachment / imported document。
- 文档导入后生成数据来源。
- 支持从 Issue、Comment、Chat、Activity Log 绑定证据。

### Phase 3：AI-Me 检索闭环

- 新增内部 retrieve 接口。
- AI-Me 大脑在生成计划、回复或调度 Agent 前检索记忆。
- 工作项详情中展示“本次使用了哪些记忆”。

### Phase 4：质量治理

- 冲突记忆检测。
- 过期提醒。
- 低置信度复核。
- 使用历史驱动的清理建议。

## 风险与约束

- 错误记忆会放大 AI-Me 的错误判断，因此 candidate gating 是 P0。
- 外部表达权限必须保守，默认不可对外。
- 不要把页面做成文件列表；用户需要治理的是“AI-Me 认为什么”，不是所有原始资料。
- 不要把所有记忆无差别注入 prompt；必须按场景检索。
- 不要把 Skill 和 Memory 合并，否则执行 SOP 和事实偏好会混在一起，后续很难治理。

## 待确认问题

- v0.1 是否需要项目级 scope 直接关联 `project` 表，还是先只支持 workspace / user / agent？
- 是否需要为 `external_use_policy=with_approval` 自动生成审批中心事项？
- 资料导入 v0.1 先支持文件上传，还是也同时支持飞书、GitHub、邮件来源？
- 记忆编辑是否需要版本历史，还是先用 activity_log 记录操作即可？
- AI-Me 直连 LLM API 的检索入口由后端统一提供，还是先由前端触发候选记忆确认后再交给后端？
