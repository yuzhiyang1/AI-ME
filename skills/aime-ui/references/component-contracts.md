# AI-Me Component Contracts

## Global tokens

Use the variables in `design-system.md`. Never add page-local arbitrary visual
values when an existing token can express the intent.

## Navigation item

- Height: 38–40px.
- Active: brand-50 background, brand-600 icon/text.
- Default: secondary text.
- Hover: muted neutral surface.
- Badge only for actionable unread/approval counts.

## Topbar

- Height: 64px.
- Bottom border, no large shadow.
- Right side: status, new work, search, notifications, avatar.

## Buttons

- Default 36px; small 30px; large 40px.
- One primary action per region.
- Secondary is white with neutral border.
- Destructive actions use danger semantics and confirmation.
- Loading must not shift width.

## Inputs

- Height 36px; 8px radius.
- Strong neutral border; brand focus ring.
- Errors use text and focused semantics, not indiscriminate red borders.

## Badges

- Short label only.
- Always include text; color alone is insufficient.
- Use for status, risk, source, worker/provider, and type.

## Tabs

- 36–40px.
- Brand text plus 2px underline for selected state.
- Avoid pill tabs except true two-mode switches.

## Cards

- White surface.
- 1px neutral border.
- 12px radius.
- 16px padding.
- Very light or no shadow.
- Avoid nesting multiple bordered cards.

## Tables and dense lists

- Header 12–13px.
- Row 44–48px.
- Neutral hover.
- Sticky actions when useful.
- Truncate long content and expose full text in details.

## Detail drawer

- 392px default, 420px on wide screens.
- Sticky header and action footer.
- Independently scrolling body.
- Tabs: 详情 / 对话 / 证据 / AI 分析 / 操作记录 when appropriate.

## State treatment

```text
新进入       neutral/subtle
AI 处理中    purple or info-blue accent
等待外部     gray-blue
需要我决策   warning/orange
严重风险     danger/red
已完成       success/green
```

Use semantic color on a line, icon, badge, small metric, or very soft column
background—not as a saturated full-page fill.

## Copy

Canonical terms:

```text
工作项
工作驾驶舱
例外收件箱
审批中心
对话与线程
记忆与知识
AI 员工
工具与权限
证据
接管
需要我决策
等待外部
```

Do not mix multiple names for the same concept.
