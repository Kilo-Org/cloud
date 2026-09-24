#!/usr/bin/env tsx
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { computeDatabaseUrl, createDrizzleClient } from '@kilocode/db';

async function main(): Promise<void> {
  const { db, pool } = createDrizzleClient({
    connectionString: computeDatabaseUrl(),
    poolConfig: { max: 1 },
  });
  try {
    await migrate(db, { migrationsFolder: resolve('packages/db/src/migrations') });
    console.log('Migrations applied successfully.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  while (error instanceof Error && error.cause instanceof Error) {
    error = error.cause;
  }

  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const databaseUrl =
    process.env.USE_PRODUCTION_DB === 'true'
      ? process.env.POSTGRES_URL_PRODUCTION
      : process.env.POSTGRES_URL;
  console.error(`Migration failed${typeof code === 'string' ? ` (${code})` : ''}:`);
  console.error(databaseUrl ? message.replaceAll(databaseUrl, '[redacted]') : message);
  process.exitCode = 1;
});
