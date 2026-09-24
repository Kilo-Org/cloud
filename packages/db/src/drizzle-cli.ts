/**
 * drizzle-kit passthrough that applies migrations through a rewritten copy
 * of the SQL files, so `CREATE INDEX CONCURRENTLY` is not executed inside
 * drizzle-orm's wrapping transaction.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';
import { writeTransactionalMigrationsFolder } from './transactional-migration-sql';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

async function runMigrate(): Promise<void> {
  dotenv.config({ path: path.join(pkgRoot, '../../.env.local'), quiet: true });
  const migrationsFolder = writeTransactionalMigrationsFolder(
    path.join(pkgRoot, 'src/migrations'),
    mkdtempSync(path.join(tmpdir(), 'drizzle-migrate-'))
  );
  const pool = new pg.Pool(getDatabaseClientConfig(computeDatabaseUrl()));
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

if (args[0] === 'migrate') {
  await runMigrate();
} else {
  const drizzleKit = path.join(pkgRoot, 'node_modules', '.bin', 'drizzle-kit');
  const result = spawnSync(drizzleKit, args, {
    cwd: pkgRoot,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
