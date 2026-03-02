# Drizzle ORM + Durable Object SQLite Migration Workflow

## Schema location

Each worker defines its schema in `src/db/sqlite-schema.ts` using `sqliteTable` from `drizzle-orm/sqlite-core`.

## Configuration

Each worker root contains a `drizzle.config.ts` that configures `drizzle-kit` with `dialect: "sqlite"` and `driver: "durable-sqlite"`. This tells drizzle-kit to generate migration SQL compatible with DO-embedded SQLite.

## Adding a migration

1. Edit `src/db/sqlite-schema.ts` in the relevant worker.
2. From the worker directory, run:
   ```
   pnpm drizzle-kit generate
   ```
3. Commit the three generated/updated artifacts:
   - The new `.sql` file in `drizzle/`
   - The updated `drizzle/migrations.js` (barrel file)
   - The updated snapshot in `drizzle/meta/`

## How migrations run

In each Durable Object constructor, `blockConcurrencyWhile` calls:

```ts
migrate(db, migrations);
```

This checks the `__drizzle_migrations` table in the DO's SQLite database and applies any pending SQL files in order. No migration runs twice; the table tracks what has already been applied.

## Important caveat

Each Durable Object instance has its own isolated SQLite database. Migrations apply **per-instance on first access after deploy** -- there is no centralized "run migrations" step. A migration only executes when a request routes to that specific DO instance for the first time post-deploy.

## Workers using this pattern

| Worker                            | Description                  |
| --------------------------------- | ---------------------------- |
| `cloud-agent`                     | Agent orchestration          |
| `cloud-agent-next`                | Next-gen agent orchestration |
| `cloudflare-ai-attribution`       | AI code attribution          |
| `cloudflare-app-builder`          | App builder                  |
| `cloudflare-o11y`                 | Observability                |
| `cloudflare-session-ingest`       | Session ingestion            |
| `cloudflare-webhook-agent-ingest` | Webhook agent ingestion      |
