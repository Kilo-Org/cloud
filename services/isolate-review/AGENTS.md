# Isolate Review

- This service is an experimental, production-excluded proof of concept.
- All application-owned Durable Object state must use repository-owned Drizzle schemas in `src/db/sqlite-schema.ts`, generated migrations in `drizzle/`, `drizzle-orm/durable-sqlite`, and Drizzle's query-builder API.
- Never access application-owned state with raw SQL or `DurableObjectStorage.get()` / `DurableObjectStorage.put()`.
- Vendor-owned SQLite schemas and migrations internal to `@cloudflare/computer` (Computer), `@cloudflare/think` (Think), and `agents` (Agent) are the only exception: they are framework-managed, not repository-managed.
- This exception applies only to those vendor-owned framework internals in this experimental, production-excluded proof of concept. It never applies to application-owned state, other services, or production deployments.
