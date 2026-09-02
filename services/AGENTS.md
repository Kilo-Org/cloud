# Services

- Before changing a service, check for and read the owning service's nearer `AGENTS.md`.
- All Durable Object SQLite code must use `drizzle-orm/durable-sqlite`.
- Use Drizzle's query-builder API for all Durable Object SQLite queries.
- Only in `services/isolate-review`, vendor-owned `@cloudflare/computer`, `@cloudflare/think`, and `agents` framework SQLite internals are exempt from the Drizzle, query-builder, and repository-owned migration requirements; all application-owned state must still use Drizzle, its query-builder API, and repository-owned migrations. Production use is restricted to the authenticated, organization-allowlisted queued GitHub path with canonical attempt authority and isolate-owned publication fences; direct/manual experimental entrypoints remain development-only.
- For Durable Object implementation and SQLite migration workflow, load the `durable-objects` skill and consult `docs/do-sqlite-drizzle.md`.
