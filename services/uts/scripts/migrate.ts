import pg from 'pg';
import { z } from 'zod';
import { applyMigrations, loadMigrations } from './migrator';

/**
 * Applies pending identity-store migrations.
 * `UTS_MIGRATION_DATABASE_URL` is a direct connection as the database's admin login.
 */

const environment = z
  .object({ UTS_MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);

const client = new pg.Client({ connectionString: environment.UTS_MIGRATION_DATABASE_URL });
await client.connect();
try {
  const run = await applyMigrations(client, await loadMigrations());
  for (const name of run.alreadyApplied) console.log(`already applied ${name}`);
  for (const name of run.applied) console.log(`applied ${name}`);
} finally {
  await client.end();
}
