# Migrations

- We use Drizzle ORM
- Database schema is defined in `packages/db/src/schema.ts`
- Migrations are stored in `packages/db/src/migrations/`
- Configuration is in `packages/db/drizzle.config.ts`
- To create a new migration follow these steps:
  1. First alter the schema in `packages/db/src/schema.ts` as appropriate
  2. Then run `pnpm drizzle generate` which will create a new migration file with a descriptive name
  3. Read the generated migration file in `packages/db/src/migrations/`
  4. Improve the migration to ensure it is as NON-DESTRUCTIVE as possible and that Drizzle didn't change more than necessary
  5. If needed, you can run `pnpm drizzle migrate` to apply migrations to the database
  6. When you're done, run `pnpm format` to autoformat
- Prefer `timestamp({ withTimezone: true })` over regular timestamp columns for better timezone handling.
