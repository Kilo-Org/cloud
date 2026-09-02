# Isolate Review

- Direct/manual experimental entrypoints remain development-only. The sole production exception is authenticated, organization-allowlisted queued GitHub reviews, admitted against canonical attempt identity and fence generation. Unsupported providers and modes remain on the legacy reviewer.
- Queued attempts use a separate Durable Object name prefix and immutable identity. Cancellation and terminal status do not release unresolved publication fences. Retain tombstones, notification capability, and uncertain-operation evidence through eviction and cleanup without reusable inference credentials.
- All application-owned Durable Object state must use repository-owned Drizzle schemas in `src/db/sqlite-schema.ts`, generated migrations in `drizzle/`, `drizzle-orm/durable-sqlite`, and Drizzle's query-builder API.
- Never access application-owned state with raw SQL or `DurableObjectStorage.get()` / `DurableObjectStorage.put()`.
- Vendor-owned SQLite schemas and migrations internal to `@cloudflare/computer` (Computer), `@cloudflare/think` (Think), and `agents` (Agent) are the only exception: they are framework-managed, not repository-managed.
- The storage exception applies only to those vendor-owned framework internals in this service, including the narrowly permitted queued path. It never applies to application-owned state or other services. This does not authorize deployment or broaden direct/manual access.
