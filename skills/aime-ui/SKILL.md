---
name: aime-ui
description: >
  Use when designing, implementing, reviewing, or refining AI-Me frontend pages
  and shared UI inside the Multica codebase. Applies to the work cockpit, work
  board, exception inbox, approval center, threads, memory and knowledge,
  AI workers, tools and permissions, settings, work-item details, drawers, and
  reusable components. Enforces a calm, reliable, evidence-first, high-density
  work-OS style. Not for backend-only changes, marketing pages, or unrelated
  Multica UI. Output: a reuse-first implementation plan, consistent responsive
  UI, complete loading/empty/error states, accessibility checks, and visual QA.
---

# AI-Me UI

Build AI-Me as a **work operating system**, not as a chat demo, marketing page,
or playful multi-agent showcase.

The interface should make the user feel that AI-Me is quietly receiving,
advancing, verifying, and closing work on their behalf. The user mainly sees:

1. outcomes;
2. work in progress;
3. waiting dependencies;
4. evidence and risk;
5. decisions that genuinely require the user.

## Use this skill when

- Creating or changing any AI-Me page in the Multica frontend.
- Adding AI-Me navigation, cards, tables, drawers, approval actions, badges,
  work-item details, memory views, or worker views.
- Translating an AI-Me product requirement into a concrete UI.
- Reviewing an AI-Me implementation for visual consistency or usability.
- Producing screenshots for UI acceptance.

## Do not use this skill when

- The task is backend-only and has no user-facing UI.
- Building a public marketing website or landing page.
- Changing unrelated Multica pages with no AI-Me product requirement.
- Creating dark mode, a theme marketplace, decorative animation, or gamified
  agent avatars for v0.1.

## Required references

Read only what is relevant to the current task:

- Full visual rules and tokens: `references/design-system.md`
- Page-level information architecture: `references/page-blueprints.md`
- Component and layout contracts: `references/component-contracts.md`
- Completion and review gates: `references/qa-checklist.md`
- Visual direction: `assets/dashboard-reference.png`
- Token and component direction: `assets/design-system-reference.png`

The reference images communicate composition and visual tone. Do not copy
possibly garbled text from them; use product terminology from the references.

## Non-negotiable product principles

### 1. Work first, chat second

The default page must not be a large chat box. Prioritize completed work,
active work, waiting dependencies, exceptions, approvals, risk, and evidence.

### 2. Exceptions first

Put items requiring the user's judgment above routine agent activity. Highlight:

- approval required;
- high risk;
- low confidence;
- missing context;
- conflicting agent conclusions;
- irreversible operations;
- policy or historical-preference conflicts.

### 3. Evidence first

Whenever AI-Me makes a consequential claim or recommendation, make its evidence
reachable: original message, code path, PR/commit, log, monitoring signal,
memory, rule, or agent run.

### 4. Calm, precise, operational

Use white surfaces, soft neutral backgrounds, restrained purple accents, gentle
semantic state colors, thin borders, compact information hierarchy, and minimal
shadow. Avoid glassmorphism, neon gradients, oversized decorative copy, playful
agent cards, and “card soup.”

### 5. Explicit actions

Approval and exception views must make the next action obvious. Use labels such
as `批准`, `编辑后批准`, `发送`, `驳回`, `接管`, and `查看证据`. One region should
normally have at most one primary action.

## Workflow

### Step 1: Classify the task

Identify whether the request is:

- a new page;
- a page refinement;
- a shared component;
- a responsive fix;
- a visual review;
- an accessibility or state-completeness review.

Identify the target page from the fixed AI-Me navigation:

1. 工作驾驶舱
2. 工作看板
3. 例外收件箱
4. 审批中心
5. 对话与线程
6. 记忆与知识
7. AI 员工
8. 工具与权限
9. 设置

### Step 2: Audit Multica before coding

Inspect existing Multica layout, sidebar, board, issue detail, drawer, button,
badge, tabs, table, form, realtime, and empty-state components.

Produce a short reuse map:

```text
Reuse unchanged:
- ...

Extend:
- ...

New AI-Me component required:
- ...
```

Do not create a second design system when an existing component can be extended
without harming current Multica behavior.

### Step 3: State the page contract

Before implementation, write a concise contract:

```text
User goal:
Primary information:
Primary action:
Secondary actions:
Required states:
Evidence shown:
Risk/approval behavior:
Responsive behavior:
```

### Step 4: Implement with shared tokens

- Use the CSS variables in `references/design-system.md`.
- Reuse or extend shared components.
- Keep TypeScript strict.
- Do not add a new large UI framework.
- Avoid arbitrary colors, spacing, radius, shadow, and inline styles.
- Use Chinese-first product copy and the canonical terminology in this skill.

### Step 5: Implement all operational states

Every data-driven page must include:

- loading;
- empty;
- populated;
- recoverable error;
- permission denied when relevant;
- disconnected/offline when relevant.

Do not use fake progress. Show real stages or indeterminate state.

### Step 6: Validate behavior and visuals

At minimum verify:

- 1440px desktop;
- 1280px desktop;
- keyboard focus and tab order;
- text wrapping and truncation;
- loading, empty, and error states;
- destructive-action confirmation;
- status text in addition to color;
- drawer focus management;
- relevant typecheck/tests.

Capture one screenshot per page or significant state. Never compress many full
pages into a single collage for implementation review.

## Fixed visual contract

- Page background: `#F7F8FB`
- Surface: `#FFFFFF`
- Border: `#E8E9EF`
- Brand: `#7657F5`
- Primary text: `#171923`
- Sidebar width: `216px`
- Topbar height: `64px`
- Detail drawer width: `392px`
- Page gutter: `24px`
- Button/input radius: `8px`
- Card radius: `12px`
- Large panel/drawer radius: `16px`
- Body text: `14px / 22px`
- Secondary metadata: `12–13px`
- Default card treatment: border + very light shadow

The exact variable names and full palette are in `references/design-system.md`.

## Fixed page hierarchy

### Work cockpit

First screen order:

1. greeting and number of jobs AI-Me has taken over;
2. summary metrics;
3. `需要我决策`;
4. active work;
5. outcomes, saved time, and trend summaries.

### Work board

Use these columns:

```text
新进入 / AI 处理中 / 等待外部 / 需要我决策 / 已完成
```

### Exception inbox

Do not mix routine completion notifications into this page. Each exception shows
original event, AI judgment, risk, confidence, recommendation, and actions.

### Approval center

Use a master-detail layout. Always show action, impact, AI recommendation,
evidence, risk, reversibility, and approval choices.

### Threads

Use timeline semantics for AI/system/worker events. Do not render every event as
a colorful chat bubble.

### Memory and knowledge

Display typed, sourced, governed memory—not merely vector chunks or a file list.
Memory entries need content, type, source, confidence, scope, timestamps, and
external-use permission.

### AI workers

Present workers as operational resources, not game characters. Prioritize
provider, status, current work, throughput, duration, success rate, and errors.

### Tools and permissions

Make permission behavior explicit in text. Example:

```text
读取代码：自动
发送飞书：需要批准
合并 PR：需要批准
生产部署：始终需要批准
```

### Settings

Use focused sections rather than a giant form. Include AI-Me enablement,
working hours, timezone, autonomy, notifications, model provider/model, data
location, retention, export/clear, and version.

## Review mode

When asked to review an existing AI-Me UI, return findings grouped as:

```text
P0 — unsafe or blocks the task
P1 — violates core product hierarchy or action clarity
P2 — consistency, responsiveness, accessibility, or polish
```

For every finding include:

- location/component;
- violated rule;
- user impact;
- smallest acceptable fix.

Do not rewrite the entire page when a small correction is sufficient.

## Definition of done

A page is not done until:

- it supports the user's operational decision, not merely displays data;
- its primary action is obvious;
- risk, confidence, and evidence are reachable when relevant;
- it uses shared tokens and components;
- all states exist;
- it works at 1440px and 1280px;
- keyboard and focus behavior are sound;
- tests/typecheck pass;
- a clear single-page screenshot is available for review.
