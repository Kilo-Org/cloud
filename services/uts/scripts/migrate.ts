import pg from 'pg';
import { z } from 'zod';
import { operatorClientConfig } from './connection';
import { applyMigrations, loadMigrations } from './migrator';

/**
 * Applies pending identity-store migrations.
 * `UTS_MIGRATION_DATABASE_URL` connects as the database's admin login, directly or through the
 * Supabase session pooler (session mode, port 5432), never through Hyperdrive or the transaction
 * pooler. A host other than loopback needs `sslmode=verify-full` and `sslrootcert` set to the
 * Supabase CA, `Supabase Root 2021 CA` (see `connection.ts`).
 */

const environment = z
  .object({ UTS_MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);

const client = new pg.Client(operatorClientConfig(environment.UTS_MIGRATION_DATABASE_URL));
await client.connect();
try {
  const run = await applyMigrations(client, await loadMigrations());
  for (const name of run.alreadyApplied) console.log(`already applied ${name}`);
  for (const name of run.applied) console.log(`applied ${name}`);
} finally {
  await client.end();
}
