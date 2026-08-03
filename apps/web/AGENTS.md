# AGENTS.md

## UI Work

When editing or reviewing UI files in `apps/web` — React components, pages, layouts, or styles (`.tsx`/`.css`) — load the `kilo-design-cloud` skill, synced from `Kilo-Org/kilo-design` into `.agents/skills/`. Never load it for non-UI work.

For `apps/web`, that skill replaces the root `DESIGN.md`. Its `src/tokens.cloud.ts` references are upstream design artifacts tracked by VVV-130, not files expected in this repository; until adoption lands, use the current Cloud semantic tokens and components.

## Web Environment Variables

When a shared web environment variable needs to be added or rotated across tracked dotenv files and Vercel deployments, tell the user to run `pnpm web:env set <VARIABLE>`. Agents must not run this command because it prompts for secret values and writes to external systems. This rule also applies to work under `scripts/web-env/`. See [DEVELOPMENT.md](../../DEVELOPMENT.md) for the user-run workflow.

## Client Server State

For React client-side server state, use the existing tRPC and React Query stack rather than custom fetch or cache state.

## Stripe Subscription Schedules

When `subscriptionSchedules.create()` uses `from_subscription`, do not set `metadata` in the create call. Set custom metadata in a subsequent `subscriptionSchedules.update()` call and test both calls.

## Database-Backed APIs

For database-backed API work, consult `packages/db/AGENTS.md` for shared PostgreSQL data-contract requirements.
