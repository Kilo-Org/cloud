import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Applies the identity-store migrations: plain SQL files named `NNNN_name.sql`, run in name order,
 * each in its own transaction. Each applied file is recorded with its SHA-256, so a second run
 * applies nothing and a file that changed after it was applied stops the run.
 *
 * An operator runs it (design section 5.2) over a direct connection as the database's admin login,
 * under the TLS rules in `connection.ts`, never through Hyperdrive, so its multi-statement
 * transactions do not reach the Worker paths.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url).href);

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/** An arbitrary constant that serializes concurrent migration runs on one database. */
const MIGRATION_LOCK_KEY = 7_420_310_551;

export type Migration = { name: string; sql: string; checksum: string };

export type MigrationRun = { applied: string[]; alreadyApplied: string[] };

export class MigrationStateError extends Error {
  override name = 'MigrationStateError';
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    if (!MIGRATION_FILE.test(name)) {
      throw new MigrationStateError(`Migration file name ${name} does not match NNNN_name.sql`);
    }
    const sql = await readFile(path.join(dir, name), 'utf8');
    migrations.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return migrations;
}

async function recordedChecksums(client: pg.Client): Promise<Map<string, string>> {
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM uts_migrations.applied ORDER BY name'
  );
  return new Map(result.rows.map(row => [row.name, row.checksum]));
}

export async function applyMigrations(
  client: pg.Client,
  migrations: readonly Migration[]
): Promise<MigrationRun> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS uts_migrations');
    await client.query(
      `CREATE TABLE IF NOT EXISTS uts_migrations.applied (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );

    const recorded = await recordedChecksums(client);
    const known = new Set(migrations.map(migration => migration.name));
    for (const name of recorded.keys()) {
      if (!known.has(name)) {
        throw new MigrationStateError(`Applied migration ${name} has no file`);
      }
    }

    const run: MigrationRun = { applied: [], alreadyApplied: [] };
    for (const migration of migrations) {
      const checksum = recorded.get(migration.name);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new MigrationStateError(`Migration ${migration.name} changed after it was applied`);
        }
        run.alreadyApplied.push(migration.name);
        continue;
      }
      if (run.alreadyApplied.length < recorded.size) {
        throw new MigrationStateError(
          `Migration ${migration.name} sorts before an applied migration; add new files at the end`
        );
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        // A migration may act as another role (`SET LOCAL ROLE uts_owner`); record it as the admin.
        await client.query('RESET ROLE');
        await client.query('INSERT INTO uts_migrations.applied (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      run.applied.push(migration.name);
    }
    return run;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
