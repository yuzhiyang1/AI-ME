# AI-ME

AI-ME is an early-stage personal work cockpit for coordinating AI employees, approvals, exceptions, memory, and external work signals from one place.

> Development status: this project is still under active development. APIs, database tables, UI copy, and product flows are expected to change quickly.

AI-ME is being built on top of the existing Multica agent-management codebase. The current direction is simple: AI-ME acts as the owner-facing brain and operating desk, while tools like Codex and Claude Code remain executable AI employees routed through the existing agent runtime.

## What AI-ME Is

AI-ME is not just another chat window. It is intended to become a work operating layer that can:

- read events from work systems such as Feishu, GitHub, issues, and future mail integrations;
- reason with an LLM brain through an OpenAI-compatible API such as DeepSeek;
- turn risky or outward-facing actions into approval items before doing anything;
- dispatch approved work to AI employees such as Codex or Claude Code;
- keep a governed memory and knowledge base for project facts, preferences, rules, and evidence.

The v0.1 product focus is the first practical loop:

```text
Work signal
-> AI-ME analysis
-> approval gate
-> issue / worker dispatch / reply draft
-> execution result and audit trail
-> memory and knowledge reuse
```

## Current Scope

The project currently includes or is actively implementing:

- **Work cockpit**: a dashboard-style view for pending decisions, AI employee work, risk, and recent activity.
- **AI employees**: Codex, Claude Code, and other agent runtimes continue to behave as assignable workers.
- **Exception inbox**: external or internal signals can be triaged into AI-ME recommendations and approval items.
- **Approval center**: risky actions are persisted, reviewed, approved, rejected, or taken over by the user.
- **Memory and knowledge**: governed context for user preferences, project facts, rules, evidence, and candidate memories.
- **LLM brain integration**: AI-ME can be configured to call an OpenAI-compatible LLM API. Local development currently targets DeepSeek because it is cost-effective.
- **External action groundwork**: Feishu webhook and approval-backed external message sending are being connected incrementally.

## UI Direction

The images below are AI-ME UI concept drafts generated with GPT. They are product direction references, not final production screenshots.

<table>
  <tr>
    <td><img src="docs/assets/ai-me-ui/01-dashboard.png" alt="AI-ME work cockpit concept" width="100%"></td>
    <td><img src="docs/assets/ai-me-ui/03-exceptions.png" alt="AI-ME exception inbox concept" width="100%"></td>
    <td><img src="docs/assets/ai-me-ui/04-approvals.png" alt="AI-ME approval center concept" width="100%"></td>
  </tr>
  <tr>
    <td><img src="docs/assets/ai-me-ui/06-memory.png" alt="AI-ME memory and knowledge concept" width="100%"></td>
    <td><img src="docs/assets/ai-me-ui/07-agents.png" alt="AI-ME AI employees concept" width="100%"></td>
    <td><img src="docs/assets/ai-me-ui/08-tools-permissions.png" alt="AI-ME tools and permissions concept" width="100%"></td>
  </tr>
</table>

More reference images are listed in [docs/ai-me-ui-reference.md](docs/ai-me-ui-reference.md).

## Architecture

AI-ME currently uses the original Multica architecture while the product surface is being reshaped:

```text
Next.js web app / Electron desktop
        |
Shared views and core packages
        |
Go backend API + WebSocket events
        |
PostgreSQL 17 with pgvector
        |
Local / cloud agent runtimes
        |
Codex, Claude Code, and other AI employee CLIs
```

Key implementation boundaries:

- `server/`: Go backend, handlers, migrations, sqlc queries, realtime events.
- `apps/web/`: Next.js web app.
- `apps/desktop/`: Electron desktop shell.
- `packages/core/`: headless API client, schemas, query hooks, types, and shared state.
- `packages/views/`: shared product pages and components.
- `packages/ui/`: reusable UI primitives and design tokens.
- `docs/`: product notes, PRDs, and UI references.

## Development

Prerequisites:

- Node.js 22+
- pnpm 10.28+
- Go 1.26+
- Docker, for local PostgreSQL

Start the local stack:

```bash
make dev
```

Useful checks:

```bash
pnpm typecheck
pnpm test
make test
make check
```

## Configuration

Use `.env.example` as the template for local configuration.

Sensitive values must stay local:

- LLM API keys, such as `AI_ME_LLM_API_KEY` or `DEEPSEEK_API_KEY`
- Feishu app secrets and webhook tokens
- OAuth secrets
- database passwords for non-local deployments

Do not commit a real `.env` file. The repository only keeps placeholders and public defaults.

## Project Notes

- This repository is currently a development-stage AI-ME fork built from the Multica foundation.
- Some internal package names, CLI names, and docs may still reference Multica while the product is being renamed.
- The project is not production-ready yet.
- The approval-first safety model is intentional: AI-ME should not send external messages, modify important data, merge code, or make commitments without an explicit approval path.

## License

See [LICENSE](LICENSE).
