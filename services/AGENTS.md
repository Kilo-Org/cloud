# Services

- Before changing a service, check for and read the owning service's nearer `AGENTS.md`.
- All Durable Object SQLite code must use `drizzle-orm/durable-sqlite`.
- Use Drizzle's query-builder API for all Durable Object SQLite queries.
- Only for the production-excluded experimental `services/isolate-review` proof of concept, vendor-owned `@cloudflare/computer`, `@cloudflare/think`, and `agents` framework SQLite internals are exempt from the Drizzle, query-builder, and repository-owned migration requirements; all application-owned state must still use Drizzle, its query-builder API, and repository-owned migrations.
- For Durable Object implementation and SQLite migration workflow, load the `durable-objects` skill and consult `docs/do-sqlite-drizzle.md`.
