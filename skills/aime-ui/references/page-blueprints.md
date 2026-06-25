# AI-Me Page Blueprints

This file is a compact implementation reference. The authoritative visual rules
remain in `design-system.md`.

## Shared shell

- Fixed 216px left navigation.
- Fixed 64px topbar.
- Independently scrolling main content.
- Optional 392px work-item/approval/thread detail drawer.
- Main content background `#F7F8FB`; panels are white.

## 1. 工作驾驶舱

**Goal:** Within ten seconds the user understands what AI-Me finished, what is
active, what is waiting, and what requires a decision.

```text
Header
Summary metrics: 自动完成 / 进行中 / 等待外部 / 需要我决策 / 严重风险
Main 60%: 需要我决策
Main 40%: 进行中的工作
Bottom: 今日成果 / 节省时间 / 异常趋势
```

Decision cards show cause, recommendation, risk, evidence shortcut, and two
clear actions.

## 2. 工作看板

Columns are fixed:

```text
新进入 / AI 处理中 / 等待外部 / 需要我决策 / 已完成
```

Card hierarchy: source/time → title → one-line summary → type/risk → worker or
waiting party → optional real progress.

## 3. 例外收件箱

Filters:

```text
全部 / 需要我决策 / 高风险 / 低置信度 / Agent 冲突 / 缺少信息
```

Each item: original event, AI assessment, risk, confidence, recommendation,
evidence link, and context-specific action.

## 4. 审批中心

Master-detail:

- left list: approximately 300px;
- right detail: remaining width;
- actions: approve, edit then approve, reject;
- show impact, evidence, risk, reversibility, and proposed payload.

## 5. 对话与线程

Two- or three-column layout:

- thread list: approximately 280px;
- conversation/timeline;
- optional task context, agents, and evidence.

Differentiate external messages, AI-Me decisions, worker updates, system events,
and approvals. Worker/system entries should look like timeline records.

## 6. 记忆与知识

Tabs:

```text
我的身份 / 我的偏好 / 判断规则 / 项目知识 / 历史经历 / 候选记忆 / 数据来源
```

Search + category rail + memory list + detail/source panel. Candidate memories
have confirm, edit, ignore.

## 7. AI 员工

Tabs:

```text
全部 / Codex Workers / Claude Workers / 其他员工
```

Rows show provider, status, current task, completed today, average duration,
success rate, last anomaly, details/pause/configure.

## 8. 工具与权限

Tool list plus details/policy panel. Classify communication, development, data,
publishing, and system tools. Show enablement, scope, caller, approval behavior,
last call, and audit entry.

## 9. 设置

Tabs:

```text
个人设置 / AI-Me 设置 / 集成设置 / 模型设置 / 安全设置 / 数据设置
```

Use small sections of four to six fields. Keep operationally important settings
visible and avoid oversized forms.

## Work-item detail

Header: ID, title, status, risk, source, time.

Tabs:

```text
概览 / 原始输入 / 执行计划 / Agent 运行 / 证据 / 审批 / 操作记录
```

Overview: goal, current judgment, stage, next action, worker, blockers,
definition of done.
