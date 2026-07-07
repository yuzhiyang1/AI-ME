# AI-Me 审批中心模块 PRD

## 背景

AI-Me 的第一阶段已经有两个关键基础：

- AI-Me 可以直连 LLM API 作为“大脑”，基于当前 workspace、issue 和 AI 员工状态生成判断与建议。
- Codex / Claude Code 等 AI 员工继续通过 Multica 的 Agent Runtime 和 `agent_task_queue` 执行工作。

但当前 AI-Me 的判断仍停留在“即时建议”层：用户输入一段需求，AI-Me 返回建议动作、风险、证据和回复草稿。这个结果如果不被保存、审批和执行，就无法形成真正的工作闭环。

审批中心要补齐这段链路：

```text
输入或事件
→ AI-Me 判断
→ 生成待审批动作
→ 用户批准 / 修改后批准 / 驳回 / 接管
→ 后端执行受控动作
→ 记录证据、结果和审计日志
```

审批中心不是一个普通“确认弹窗集合”，而是 AI-Me 自主工作能力的安全闸门。它决定 AI-Me 什么时候只能建议，什么时候可以推动事情进入 issue、评论、Agent task、外部消息或集成系统。

## 问题陈述

用户希望 AI-Me 能主动推进工作，但不能接受它擅自：

- 对外发送消息；
- 合并 PR；
- 创建或分配高风险任务；
- 修改生产数据；
- 删除、归档或取消重要工作；
- 使用未经确认的记忆对外表达；
- 代表用户作出承诺。

因此，AI-Me 需要一个集中、可追溯、可编辑的审批中心，让用户快速判断“这件事能不能让 AI-Me 继续做”，并且所有高风险动作都必须保留证据和审计记录。

## 目标

- 保存 AI-Me 生成的待审批动作，而不是只在前端临时展示。
- 展示每个待审批事项的来源、动作、影响范围、风险、置信度、证据和可回滚性。
- 支持 `批准`、`编辑后批准`、`驳回`、`接管`、`继续观察`。
- 批准后由后端执行受控动作，例如创建 issue、分配 AI 员工、生成评论草稿、标记等待外部。
- 与现有 `issue`、`agent_task_queue`、`comment`、`inbox_item`、`activity_log`、`memory_entry` 复用，而不是创建第二套任务系统。
- 对不可逆或外部动作默认要求审批，避免 AI-Me 越权。
- 为工作驾驶舱和例外收件箱提供“需要我决策”的统一数据来源。

## 非目标

- v0.1 不允许 AI-Me 自动执行对外发送、合并、部署、删除、生产数据修改。
- v0.1 不做复杂企业审批流，例如多人会签、组织层级、SLA 自动升级。
- v0.1 不接真实 GitHub merge / deployment / payment refund 执行，只先建立审批对象和安全执行框架。
- v0.1 不把审批中心做成通用 BPM 系统。
- v0.1 不把 Codex / Claude Code 的内部工具授权弹窗搬进审批中心；这里审批的是 AI-Me 业务动作，不是 Agent CLI 的每一次 shell/tool call。

## 核心概念

### 审批事项

AI-Me 认为需要用户确认后才能执行的动作。它可以来自：

- AI-Me 工作驾驶舱的手动判断；
- 外部事件，例如飞书、邮件、GitHub PR、告警；
- 例外收件箱中的风险判断；
- 记忆与知识模块的候选记忆或外部使用权限；
- AI 员工运行结果，例如 Codex 完成后建议创建 follow-up issue。

### 建议动作

审批事项中真正要执行的动作。v0.1 建议支持：

- `create_issue`：创建 issue。
- `assign_worker`：把现有 issue 分配给 AI 员工并入队。
- `draft_reply`：生成对外回复草稿，但不自动发送。
- `post_internal_comment`：在 issue 内发布内部评论。
- `confirm_memory`：确认候选记忆。
- `no_action`：只记录判断，不执行。

后续再扩展：

- `send_external_message`
- `merge_pull_request`
- `deploy`
- `modify_data`
- `grant_permission`

### 风险等级

审批事项的整体风险：

- `low`：内部记录、低影响、可轻易撤销。
- `medium`：会影响工作流、分配、issue 状态或团队协作。
- `high`：对外表达、生产影响、权限、数据、合并、部署、客户承诺。

### 可回滚性

用户批准前必须知道动作是否容易撤销：

- `reversible`：可以简单撤销，例如取消分配、关闭草稿。
- `partially_reversible`：可以补救但会留下外部痕迹，例如发送评论后再更正。
- `irreversible`：不可逆或高代价，例如删除、退款、生产变更。

### 证据

支持 AI-Me 建议的上下文，例如：

- 用户原始输入；
- Issue / 评论 / Activity；
- AI 员工运行结果；
- PR / commit / CI；
- 飞书或邮件原文；
- 记忆与规则；
- 日志或监控。

### 执行结果

审批通过后的后端执行记录。它应该能回指到：

- 创建的 issue；
- 入队的 agent task；
- 生成的 comment；
- 更新的 memory；
- 失败原因和错误日志。

## 用户故事

1. 作为 AI-Me 用户，我想集中看到所有待我决策的事项，以免重要动作散落在驾驶舱、聊天和外部消息里。
2. 作为 AI-Me 用户，我想知道 AI-Me 准备执行什么动作、为什么建议这么做、风险是什么，以便快速批准或驳回。
3. 作为 AI-Me 用户，我想在批准前编辑动作内容，例如改回复草稿、改 issue 标题、换 AI 员工。
4. 作为 AI-Me 用户，我想看到证据和原始来源，以便确认 AI-Me 没有误解上下文。
5. 作为 AI-Me 用户，我想知道动作是否可回滚，以便对高风险动作更加谨慎。
6. 作为 AI-Me 用户，我想把一个建议动作批准后直接生成 issue 并分配给 Codex 或 Claude Code。
7. 作为 AI-Me 用户，我想把不应该执行的建议驳回，并记录原因，让后续判断可复盘。
8. 作为 AI-Me 用户，我想接管某个审批事项，把它变成手动处理，而不是让 AI-Me 继续推进。
9. 作为 AI-Me 用户，我想筛选高风险、外部发送、分配员工、记忆确认等类型，以便批量处理低风险事项。
10. 作为 AI-Me 用户，我想审批记录保留操作人、时间、原始 payload 和最终 payload，以便审计。

## 产品结构

### 固定导航入口

导航名称：`审批中心`

建议路径：

- Web：`/:workspaceSlug/approvals`
- Desktop：工作区内 tab route `approvals`

### 页面 Tabs

v0.1 使用以下 Tabs：

- `待审批`
- `已批准`
- `已驳回`
- `历史记录`

顶部筛选：

- `全部`
- `高风险`
- `对外动作`
- `创建任务`
- `分配员工`
- `记忆确认`
- `失败重试`

### 页面布局

参考 04-approvals 设计稿，采用三段式工作台：

```text
左侧：审批队列，约 320px
中间：审批详情，剩余主宽度
右侧：风险与证据，约 320-360px
底部：当前审批事项的 sticky 操作区
```

#### 左侧队列

展示：

- 标题；
- 来源；
- 等待时长；
- 风险；
- 状态；
- 建议动作类型；
- 是否已生成草稿或校验通过。

排序：

1. 高风险；
2. 等待时间长；
3. 外部动作；
4. 低置信度；
5. 普通创建任务。

#### 中间详情

展示：

- 审批事项标题；
- 来源与关联对象；
- AI-Me 建议摘要；
- 将要执行的动作；
- 原始 payload；
- 最终 payload；
- 影响范围；
- 校验结果；
- Agent / issue / memory 关联；
- 审批后的后续步骤。

#### 右侧风险与证据

展示：

- 综合风险；
- 置信度；
- 风险来源；
- 可回滚性；
- 关联证据列表；
- 使用过的记忆或规则；
- 审批后动作预览；
- 审计提示。

#### 底部操作区

待审批状态：

- Primary：`批准`
- Secondary：`编辑后批准`
- Secondary：`继续观察`
- Danger：`驳回`
- Ghost：`接管`

高风险动作的 Primary 文案应更具体：

- `批准并创建 issue`
- `批准并分配员工`
- `确认为记忆`
- `保存草稿`

## 页面契约

```text
User goal:
快速、安全地决定 AI-Me 可以继续执行哪些动作。

Primary information:
待审批动作、AI 建议、风险、置信度、影响范围、证据、可回滚性、最终 payload。

Primary action:
批准当前动作，并由后端执行对应受控动作。

Secondary actions:
编辑后批准、驳回、继续观察、接管、查看证据、跳转关联 issue/agent/memory。

Required states:
loading、empty、populated、recoverable error、permission denied、disconnected/offline、executing、execution failed。

Evidence shown:
原始输入、Issue、评论、Activity、Agent task、PR/CI、飞书/邮件、记忆、规则、日志。

Risk/approval behavior:
对外发送、删除、合并、部署、权限、生产数据、外部承诺、使用 with_approval 记忆，一律进入待审批。

Responsive behavior:
1440px 使用三栏；1280px 保留左队列和中详情，右侧风险证据可变为抽屉；更窄视口使用队列 → 详情二级导航。
```

## 复用地图

Reuse unchanged:

- `issue` 作为最终工作项，不为 AI-Me 重新造任务系统。
- `agent_task_queue` 作为 AI 员工执行队列。
- `comment` 作为 issue 内部沟通记录。
- `inbox_item` 可用于给用户发“审批完成/失败”的通知。
- `activity_log` 记录审批创建、批准、驳回和执行结果。
- `memory_entry` 的 candidate / active / rejected 状态可复用到记忆确认类审批。
- 现有 Dashboard layout、sidebar、button、badge、tabs、表格/列表样式。

Extend:

- AI-Me `/api/ai-me/think` 返回建议后，可以选择保存为审批事项。
- 工作驾驶舱的 `需要我决策` 指标应读取审批中心的 pending 数量。
- 例外收件箱可以把需要用户动作的 exception 转成 approval。
- 记忆与知识模块中 `external_use_policy=with_approval` 的外部使用，转成 approval。

New AI-Me component required:

- `ApprovalCenterPage`
- `ApprovalQueue`
- `ApprovalDetail`
- `ApprovalRiskPanel`
- `ApprovalEvidenceList`
- `ApprovalPayloadEditor`
- `ApprovalActionFooter`

## 数据模型草案

### ai_me_approval

审批事项主表。

字段建议：

- `id`
- `workspace_id`
- `requester_user_id`
- `source_type`
- `source_ref_id`
- `source_url`
- `title`
- `summary`
- `status`
- `risk_level`
- `confidence`
- `reversibility`
- `action_type`
- `action_title`
- `action_description`
- `original_payload`
- `final_payload`
- `ai_reasoning_summary`
- `approval_note`
- `rejection_reason`
- `approved_by`
- `approved_at`
- `rejected_by`
- `rejected_at`
- `executed_at`
- `execution_status`
- `execution_error`
- `created_issue_id`
- `created_task_id`
- `created_comment_id`
- `memory_id`
- `expires_at`
- `created_at`
- `updated_at`

枚举建议：

- `source_type`：`ai_me_think`、`exception`、`inbox`、`issue`、`comment`、`agent_task`、`memory`、`feishu`、`email`、`github`、`manual`
- `status`：`pending`、`approved`、`rejected`、`observing`、`taken_over`、`expired`
- `risk_level`：`low`、`medium`、`high`
- `reversibility`：`reversible`、`partially_reversible`、`irreversible`
- `action_type`：`create_issue`、`assign_worker`、`draft_reply`、`post_internal_comment`、`confirm_memory`、`no_action`
- `execution_status`：`not_started`、`running`、`succeeded`、`failed`、`skipped`

索引建议：

- `(workspace_id, status, created_at DESC)`
- `(workspace_id, risk_level, status, created_at DESC)`
- `(workspace_id, source_type, source_ref_id)`
- `(created_issue_id)`
- `(created_task_id)`
- `(memory_id)`

### ai_me_approval_evidence

审批证据表。

字段建议：

- `id`
- `approval_id`
- `workspace_id`
- `evidence_type`
- `label`
- `ref_id`
- `source_url`
- `quote`
- `metadata`
- `created_at`

枚举建议：

- `evidence_type`：`user_input`、`issue`、`comment`、`activity`、`agent_task`、`memory`、`document`、`feishu`、`email`、`github`、`ci`、`log`

### ai_me_approval_event

审批操作记录表。

字段建议：

- `id`
- `approval_id`
- `workspace_id`
- `actor_type`
- `actor_id`
- `event_type`
- `from_status`
- `to_status`
- `payload`
- `created_at`

枚举建议：

- `event_type`：`created`、`edited`、`approved`、`rejected`、`observing`、`taken_over`、`execution_started`、`execution_succeeded`、`execution_failed`、`expired`

## 状态机

```text
pending
  ├─ approve → approved → execution_started → execution_succeeded
  │                                      └──→ execution_failed
  ├─ edit_then_approve → approved → execution_started
  ├─ reject → rejected
  ├─ observe → observing
  ├─ take_over → taken_over
  └─ expire → expired
```

约束：

- 只有 `pending` 和 `observing` 可以批准。
- `approved` 后不能修改 final payload。
- `execution_failed` 可以重试，但必须创建 event。
- `rejected`、`taken_over`、`expired` 不执行动作。
- 高风险动作必须有 `approval_note` 或显式二次确认。

## API 草案

### `GET /api/ai-me/approvals`

查询审批列表。

查询参数：

- `status`
- `risk_level`
- `action_type`
- `source_type`
- `limit`
- `offset`

返回：

```json
{
  "approvals": [],
  "total": 0
}
```

### `GET /api/ai-me/approvals/{id}`

查询详情，包含 evidence 和 events。

### `POST /api/ai-me/approvals`

创建审批事项。

使用场景：

- AI-Me think 结果保存；
- 例外收件箱转审批；
- 记忆候选转审批。

### `PATCH /api/ai-me/approvals/{id}`

编辑待审批事项的 final payload、标题、说明和备注。

只允许 `pending` 或 `observing`。

### `POST /api/ai-me/approvals/{id}/approve`

批准并执行。

请求体：

```json
{
  "note": "同意创建任务并交给 Codex",
  "final_payload": {}
}
```

### `POST /api/ai-me/approvals/{id}/reject`

驳回。

请求体：

```json
{
  "reason": "风险判断不成立，先不要处理"
}
```

### `POST /api/ai-me/approvals/{id}/observe`

继续观察，不执行。

### `POST /api/ai-me/approvals/{id}/take-over`

用户接管，不再由 AI-Me 推进。

### `POST /api/ai-me/think-and-save`

后续可选接口：让 AI-Me 判断后直接保存审批事项。

v0.1 可以先不加，先由前端调用 `thinkAIMe` 后再调用 `POST /api/ai-me/approvals`。

## 执行动作映射

### create_issue

批准后：

1. 调用现有 `CreateIssue` 逻辑。
2. `creator_type=member`，`creator_id=approved_by`。
3. 如果 final payload 指定 `assignee_type=agent` 且 agent ready，则复用现有 `TaskService.EnqueueTaskForIssue`。
4. 写入 `created_issue_id` 和可选 `created_task_id`。
5. 记录 `activity_log`。

### assign_worker

批准后：

1. 校验 issue 属于当前 workspace。
2. 校验 agent 属于当前 workspace 且未 archived、有 runtime。
3. 更新 issue assignee。
4. 复用现有 assignment changed 后的 task enqueue 路径，或显式调用 `TaskService.EnqueueTaskForIssue`。
5. 写入 `created_task_id`。

### draft_reply

v0.1 只保存草稿，不自动对外发送。

批准后：

- 可创建内部 comment，或存为审批执行结果中的 draft。
- 如果目标是飞书/邮件，对外发送动作进入后续版本。

### post_internal_comment

批准后：

- 在关联 issue 下创建 `comment`。
- `author_type=member`，`author_id=approved_by`。
- 可在 comment 内容中注明由 AI-Me 起草并经用户批准。

### confirm_memory

批准后：

- 调用现有 `ConfirmMemoryEntry` 或 `UpdateMemoryEntry + ConfirmMemoryEntry`。
- 写入 `memory_id`。
- 记录证据与使用策略。

## 与 AI-Me 大脑的关系

当前 `ThinkAIMe` 返回：

- `summary`
- `risk_level`
- `confidence`
- `need_approval`
- `reply_draft`
- `reasoning_summary`
- `actions`
- `evidence`

审批中心的 v0.1 转换规则：

- `need_approval=true`：默认保存为 `ai_me_approval.status=pending`。
- 多个 `actions`：每个 action 生成一个审批事项，或生成一个包含多动作 payload 的审批事项。v0.1 建议一个 action 一个审批事项，便于执行和审计。
- `requires_approval=true`：即使整体 `need_approval=false`，该 action 仍进入审批中心。
- `risk_level=high`：必须进入审批中心。
- `draft_reply`：默认进入审批中心，不自动发送。
- `assign_worker`：如果只是创建内部工作项，可允许低风险后续配置为自动；v0.1 仍全部审批。

## 与其他模块关系

### 工作驾驶舱

驾驶舱中的 `需要我决策` 应读取：

- pending approval 数量；
- high risk pending 数量；
- 最近 3-5 个待审批事项。

### 工作看板

看板中的 `需要我决策` 列可以展示审批事项和需要决策的 issue，但 v0.1 应避免混淆：

- issue 卡仍代表工作项；
- approval 卡代表待确认动作；
- 点击 approval 进入审批中心或打开详情。

### 例外收件箱

例外负责“发现问题”，审批负责“确认动作”。

流程：

```text
Exception → AI-Me 建议动作 → Approval → 执行
```

### 记忆与知识

候选记忆仍在记忆页面治理；但以下情况进入审批中心：

- 候选记忆来自高风险外部输入；
- 记忆要用于对外表达，且 `external_use_policy=with_approval`；
- AI-Me 建议把历史经验升级为判断规则。

### AI 员工

审批通过后才能创建或分配 Agent task。审批中心不展示 Agent 的全部运行细节，只展示和本审批相关的执行结果。

### 工具与权限

审批中心执行时必须读取工具权限策略。后续版本可把 `action_type` 和工具权限策略绑定：

```text
发送飞书：需要批准
合并 PR：需要批准
读取 issue：自动
创建内部 issue：需要批准或低风险自动
```

## 前端落地结构

建议新增：

```text
packages/core/approvals/
  index.ts
  queries.ts
  mutations.ts

packages/core/types/approval.ts

packages/views/approvals/
  index.ts
  components/
    approval-center-page.tsx
    approval-queue.tsx
    approval-detail.tsx
    approval-risk-panel.tsx
    approval-evidence-list.tsx
    approval-payload-editor.tsx
    approval-action-footer.tsx

apps/web/app/[workspaceSlug]/(dashboard)/approvals/page.tsx
apps/desktop/src/renderer/src/routes.tsx
```

导航：

- `packages/core/paths/paths.ts` 增加 `approvals()`
- `packages/views/layout/app-sidebar.tsx` 增加 `审批中心`
- search command 增加审批中心入口
- reserved slug 增加 `approvals`

## 后端落地结构

建议新增：

```text
server/migrations/085_ai_me_approvals.up.sql
server/migrations/085_ai_me_approvals.down.sql
server/pkg/db/queries/approval.sql
server/internal/handler/approval.go
server/internal/handler/approval_test.go
```

需要增加协议事件：

```text
approval:created
approval:updated
approval:approved
approval:rejected
approval:execution_succeeded
approval:execution_failed
```

React Query 收到事件后 invalidate approvals、issues、agents、memory、inbox。

## 安全与权限

- 所有审批接口必须走 `RequireWorkspaceMember`。
- 批准动作必须使用当前登录用户作为 `approved_by`。
- 执行前重新校验 workspace 归属，不信任 final payload 中的 ID。
- `assign_worker` 必须校验 agent 未 archived 且 runtime 可用。
- `confirm_memory` 必须校验 memory 属于当前 workspace。
- `post_internal_comment` 必须校验 issue 属于当前 workspace。
- 高风险动作必须保留原始 payload 和最终 payload。
- 驳回和接管必须记录原因或备注。
- 前端隐藏按钮不等于权限控制。

## 空状态与错误状态

### Empty

文案：

```text
暂无待审批事项。
AI-Me 会继续在后台分析工作，只有真正需要你确认的动作才会出现在这里。
```

### Execution failed

必须展示：

- 哪个动作失败；
- 后端错误；
- 是否已部分执行；
- 可以重试还是必须接管；
- 已创建的对象 ID。

### Permission denied

文案要明确：

```text
你没有权限审批此工作区的 AI-Me 动作。
```

## 分阶段计划

### Phase 1：审批对象和页面骨架

- 建表：`ai_me_approval`、`ai_me_approval_evidence`、`ai_me_approval_event`。
- 增加列表、详情、创建、编辑、批准、驳回 API。
- 前端实现审批中心三栏 UI。
- AI-Me think 结果可以手动保存为审批事项。
- 批准后先只支持 `no_action`、`draft_reply`、`post_internal_comment`。

验收：

- 能看到待审批队列。
- 能查看风险、证据、payload。
- 能批准、驳回、继续观察、接管。
- 所有操作写入 event。

### Phase 2：创建 issue 和分配 AI 员工

- 支持 `create_issue`。
- 支持 `assign_worker`。
- 批准后复用现有 issue 创建、分配和 `TaskService.EnqueueTaskForIssue`。
- 驾驶舱 `需要我决策` 接 pending approvals。

验收：

- AI-Me 建议“交给 Codex”后，用户批准即可创建 issue 并入队。
- 创建出来的 issue 能在现有 Issue 页面看到。
- Agent task 能被现有 runtime 领取。

### Phase 3：例外与记忆接入

- 例外收件箱可转审批。
- 候选记忆和 `with_approval` 外部使用可转审批。
- 审批详情显示使用过的记忆和规则。

验收：

- 记忆外部使用必须经过审批。
- 例外建议动作能进入审批中心。

### Phase 4：外部动作扩展

- 飞书/邮件草稿发送。
- GitHub PR merge。
- 部署和生产数据修改只保留框架，不默认开放。

验收：

- 所有外部动作都有明确权限策略和审计记录。

## 风险

- 如果审批事项和 issue 概念混淆，用户会不知道自己是在批准动作还是处理工作项。
- 如果批准后执行逻辑绕开现有 `TaskService`，容易产生和 Agent runtime 不一致的任务状态。
- 如果只保存 LLM 输出而不保存最终 payload，后续审计无法解释“用户到底批准了什么”。
- 如果 v0.1 开放自动发送或合并，安全边界会过早变复杂。

## 开放问题

- `create_issue + assign_worker` 是否应该作为一个复合审批，还是拆成两个独立审批？v0.1 建议复合 payload，但执行事件分步记录。
- 审批中心是否需要批量批准低风险项？v0.1 可以先做 UI 入口但不实现批量执行。
- `draft_reply` 的草稿应存放在 approval `final_payload`，还是未来建立 `draft` 表？v0.1 先存在 approval。
- 记忆确认类审批是否应该完全复用记忆页面的 candidate 动作？建议保留记忆页治理入口，审批中心只承接高风险或跨模块使用场景。
- AI-Me 是否需要自动过期审批？建议 v0.1 支持 `expires_at`，但先不做后台自动过期任务。

## 下一步建议

第一步不要直接做外部发送，也不要做复杂权限矩阵。最小闭环应该是：

```text
AI-Me 生成建议
→ 保存为 pending approval
→ 用户批准
→ 创建 issue
→ 分配给 Codex / Claude Code
→ agent_task_queue 入队
→ 审批记录显示执行成功
```

这条链路一旦跑通，AI-Me 就从“会分析”变成“能在你确认后推进工作”。
