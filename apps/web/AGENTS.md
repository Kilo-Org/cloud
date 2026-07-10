# AGENTS.md

## UI Work

When editing UI files in `apps/web` — React components, pages, layouts, or styles (`.tsx`/`.css`) — use the `/kilo-design` skill.

## Web Environment Variables

When a shared web environment variable needs to be added or rotated across tracked dotenv files and Vercel deployments, tell the user to run `pnpm web:env set <VARIABLE>`. Agents must not run this command because it prompts for secret values and writes to external systems. This rule also applies to work under `scripts/web-env/`. See [DEVELOPMENT.md](../../DEVELOPMENT.md) for the user-run workflow.

## Client Server State

For React client-side server state, use the existing tRPC and React Query stack rather than custom fetch or cache state.

## Stripe Subscription Schedules

When `subscriptionSchedules.create()` uses `from_subscription`, do not set `metadata` in the create call. Set custom metadata in a subsequent `subscriptionSchedules.update()` call and test both calls.

## Database-Backed APIs

For database-backed API work, consult `packages/db/AGENTS.md` for shared PostgreSQL data-contract requirements.
