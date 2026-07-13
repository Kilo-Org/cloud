# Repository Guide

## Repository Overview

Monorepo for Kilo Code cloud platform. Use pnpm; required version is in root
`package.json`'s `packageManager` field. Before changing a subtree, check for a
nearer `AGENTS.md` and follow its scoped invariants.

| Path | Description |
|---|---|
| `apps/web/` | Next.js web application deployed to Vercel |
| `apps/mobile/` | React Native mobile application |
| `apps/extension/` | WXT browser extension |
| `services/` | Cloudflare Worker and supporting services |
| `packages/` | Shared libraries, including database, tRPC, and Worker utilities |
| `dev/` | Local development tooling, Docker Compose, environment sync, and seed data |
| `scripts/` | CI and one-off repository scripts |
| `.specs/` | Domain business-rule specs |
| `.agents/skills/` | Third-party skills managed with the `npx skills` command |
| `.kilo/` | Repository-owned commands, agents, and skills |

## Common Locations

| Need | Location |
|---|---|
| Root scripts and dependency entry point | `package.json` |
| PostgreSQL schema | `packages/db/src/schema.ts` |
| PostgreSQL migrations | `packages/db/src/migrations/` |
| Shared PostgreSQL contracts and migration invariants | `packages/db/AGENTS.md` |
| Durable Object SQLite conventions | `durable-objects` skill, `docs/do-sqlite-drizzle.md`, and owning service `AGENTS.md` |
| Web tRPC routers | `apps/web/src/routers/` |
| Local environment values | Root `.env.local` |
| Environment variable catalog | `ENVIRONMENT.md` |
| Local setup and service management | `DEVELOPMENT.md` and `dev/` |

Consumers of raw `@kilocode/db` values must consult `packages/db/AGENTS.md` for
data-contract caveats, even when changed code is outside `packages/db`.

## Standard Commands

| Command | Purpose |
|---|---|
| `pnpm format` | Format supported files |
| `pnpm typecheck` | Run repository TypeScript checks |
| `pnpm lint` | Run repository lint checks |
| `pnpm test` | Run root test script; currently web and web-env tests, not every package suite |
| `pnpm validate` | Run root typecheck, lint, and test scripts |

Package-level scripts are in the relevant `package.json`. Read root and relevant
package manifests before running repository JavaScript or package scripts. Load
`repository-verification` to select narrow checks and prepare test dependencies.

## Guidance Map

| Task | Source |
|---|---|
| Path-specific invariants | Nearest relevant nested `AGENTS.md` |
| TypeScript implementation or review | `code-quality` skill |
| Verification or pre-commit checks | `repository-verification` skill |
| Local services, ports, and fake login | `local-development` skill |
| Shared web environment changes | `apps/web/AGENTS.md` and `DEVELOPMENT.md` |
| PostgreSQL schema or migration work | `packages/db/AGENTS.md` and `database-migrations` skill |
| Service, Durable Object, or Worker code | `services/AGENTS.md`, nearest owning service's `AGENTS.md`, and relevant Durable Objects or Workers skills |
| Domain language and ownership | `CONTEXT.md`, when its scope applies |
| Business requirements | Relevant `.specs/*.md`, indexed by `specs` skill |
| UI and product design | `DESIGN.md`, relevant app `AGENTS.md`, and `kilo-design` skill |
| Contribution and PR workflow | `CONTRIBUTING.md` and relevant Git or PR skill |

## Security Baseline

- Never log tokens, credentials, API keys, authentication headers, cookies, or webhook secrets. Use `redactSensitiveHeaders` when headers must be retained or logged. Do not enable `sendDefaultPii` or `attachRpcInput` in Sentry.
