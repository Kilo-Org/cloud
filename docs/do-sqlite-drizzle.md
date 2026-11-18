# Drizzle ORM + Durable Object SQLite Migration Workflow

## Schema location

Each worker defines its schema in `src/db/sqlite-schema.ts` using `sqliteTable` from `drizzle-orm/sqlite-core`.

A worker that owns more than one Durable Object database keeps each schema beside
its owner, for example `src/control-plane/sandbox/sqlite-schema.ts` and
`src/control-plane/session/sqlite-schema.ts`. Each schema has its own
worker-root `drizzle.<plane>.config.ts` and `drizzle/` directory, with its own
`meta/_journal.json` and `migrations.js` barrel.

## Configuration

Each worker root contains a `drizzle.config.ts` that configures `drizzle-kit` with `dialect: "sqlite"` and `driver: "durable-sqlite"`. This tells drizzle-kit to generate migration SQL compatible with DO-embedded SQLite.

## Adding a migration

1. Edit the schema for the owning Durable Object.
2. From the worker directory, run:
   ```
   pnpm drizzle-kit generate
   ```
   For a worker with several schema roots, pass that root's config, for example
   `pnpm drizzle-kit generate --config drizzle.sandbox.config.ts`.
3. Commit the three generated/updated artifacts:
   - The new `.sql` file in the same `drizzle/` directory
   - The updated `drizzle/migrations.js` (barrel file) for that root
   - The updated snapshot in that root's `drizzle/meta/`

## How migrations run

In each Durable Object constructor, `blockConcurrencyWhile` calls:

```ts
migrate(db, migrations);
```

This checks the `__drizzle_migrations` table in the DO's SQLite database and applies any pending SQL files in order. No migration runs twice; the table tracks what has already been applied.

## Important caveat

Each Durable Object instance has its own isolated SQLite database. Migrations apply **per-instance on first access after deploy** -- there is no centralized "run migrations" step. A migration only executes when a request routes to that specific DO instance for the first time post-deploy.

## Workers using this pattern

| Worker | Description |
|---|---|
| `cloud-agent` | Agent orchestration |
| `cloud-agent-next` | Next-gen agent orchestration |
| `cloudflare-ai-attribution` | AI code attribution |
| `cloudflare-o11y` | Observability |
| `cloudflare-session-ingest` | Session ingestion |
| `cloudflare-webhook-agent-ingest` | Webhook agent ingestion |
