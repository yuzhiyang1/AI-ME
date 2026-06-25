# Example Codex Task Prompt

```text
Use the `aime-ui` skill for this task.

Task: Implement the AI-Me Exception Inbox in the current Multica frontend.

Requirements:
- Audit existing Multica list, filter, badge, drawer, button, and empty-state
  components before coding.
- Return a reuse map and minimal file-change plan first.
- Implement filters for: 全部、需要我决策、高风险、低置信度、Agent 冲突、缺少信息.
- Each row must show the original event, AI judgment, risk, confidence,
  recommendation, evidence entry, and context-specific actions.
- Do not include routine completion notifications.
- Use an optional 392px detail drawer.
- Implement loading, empty, error, permission, and populated states.
- Validate keyboard focus, Chinese text wrapping, 1440px and 1280px layouts.
- Run relevant typecheck/tests and provide one clean screenshot of the page.
```
