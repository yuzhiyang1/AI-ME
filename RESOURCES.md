# Codex 上下文管理学习资源

## Knowledge

- [Codex `session/token_budget.rs`](https://github.com/openai/codex/blob/0d46c252b3f29f10bacf0ef58a17a1aa5d17ead3/codex-rs/core/src/session/token_budget.rs)
  Token Budget 启用条件、模型默认值、提醒与兜底提示的主要实现。用于理解功能入口和预算耗尽前的行为。
- [Codex `compact_token_budget.rs`](https://github.com/openai/codex/blob/0d46c252b3f29f10bacf0ef58a17a1aa5d17ead3/codex-rs/core/src/compact_token_budget.rs)
  不调用摘要模型、直接安装新上下文窗口的核心生命周期。用于理解它为何仍被归类为 compaction。
- [Codex `session/mod.rs`](https://github.com/openai/codex/blob/0d46c252b3f29f10bacf0ef58a17a1aa5d17ead3/codex-rs/core/src/session/mod.rs#L4265)
  `start_new_context_window`、历史替换和 CompactedItem 持久化。用于追踪窗口切换后的真实状态。
- [Codex History & Notes tools](https://github.com/openai/codex/blob/0d46c252b3f29f10bacf0ef58a17a1aa5d17ead3/codex-rs/ext/history-notes/src/tools.rs)
  跨窗口 notes 与只读 history 的工具契约。用于理解 Agent 如何恢复未自动带回的新窗口信息。
- [Codex `context_window.rs`](https://github.com/openai/codex/blob/0d46c252b3f29f10bacf0ef58a17a1aa5d17ead3/codex-rs/core/src/session/context_window.rs)
  基础阈值、兜底缓冲、完整窗口硬上限与作用域计算。用于理解什么时候提醒和切换。

## Wisdom (Communities)

- [OpenAI Codex GitHub Issues](https://github.com/openai/codex/issues)
  查看真实用户遇到的上下文恢复、压缩和长任务问题。用于验证源码设计在真实使用中的表现。

## Gaps

- Token Budget 仍是 UnderDevelopment 功能，公开源码不能代表所有线上开关和服务端 History/Notes 实现细节。
