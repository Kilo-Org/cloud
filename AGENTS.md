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
| `pnpm test` | Run web, web-env, and local development-tool tests; not every package suite |
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
| UI and product design | `DESIGN.md`, relevant app `AGENTS.md`; for `apps/web`, the `kilo-design-cloud` skill synced from `Kilo-Org/kilo-design` |
| Contribution and PR workflow | `CONTRIBUTING.md` and relevant Git or PR skill |

## Vercel Function Regions

Our functions only ever run in these regions, regardless of what request metadata
suggests:

| Vercel project | Function regions |
|---|---|
| `kilocode-app` | Frankfurt only |
| `kilocode-global-app` | Frankfurt and us-west (SFO) |

Treat this table as the source of truth for compute location, database
round-trip latency, and replica reasoning. If an observed region is not `fra1` or
`sfo1`, it is a proxy/edge hop, not the function. Confirm against the Vercel
project's region list rather than inferring from a request or log field.

Region fields are not interchangeable. Per Vercel's Log Drains reference:

| Field | Meaning |
|---|---|
| `executionRegion` | Region where the request is executed |
| `proxy.lambdaRegion` | Region where the function executed |
| `proxy.region` | Region where the request is **processed** — the proxy/edge hop |

So a `region` field on a log's proxy object is the edge, and `executionRegion` /
`proxy.lambdaRegion` are the function. Do not quote a bare "region" from a log
line as the compute location without checking which of these it maps to.

`x-vercel-id` mixes both: Vercel documents it as "a list of Vercel regions your
request hit, as well as the region the function was executed in". Never read its
leading token as the compute location, especially for requests that pass through
a rewrite to another Vercel app, where PoP hops accumulate.

`VERCEL_REGION` is documented as "the ID of the Region where the app is running",
i.e. the function region. Given the table above it should only ever be `fra1` or
`sfo1`, which is what makes `isUSRegion` in `apps/web/src/lib/drizzle.ts` behave
correctly for the SFO half of `kilocode-global-app`.

## Security Baseline

- Never log tokens, credentials, API keys, authentication headers, cookies, or webhook secrets. Use `redactSensitiveHeaders` when headers must be retained or logged. Do not enable `sendDefaultPii` or `attachRpcInput` in Sentry.

## Kilobot Review Remarks

When addressing a Kilobot review remark:

1. Verify that the remark is valid. If unsure, attempt to reproduce it with an E2E or unit test.
2. If valid, fix it and commit the change. Prefer small commits in general.
3. Reply in the review thread, then resolve the thread.
4. Push the commits.
