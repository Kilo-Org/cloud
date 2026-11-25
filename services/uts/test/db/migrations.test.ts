import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationStateError,
  type Migration,
  applyMigrations,
  loadMigrations,
} from '../../scripts/migrator';
import { IDENTITY_STORE_TABLES } from '../../src/db/rows';
import { TestDatabase, sqlStateOf } from './harness';

describe('identity-store migrations', () => {
  let db: TestDatabase;
  let migrations: Migration[];

  beforeAll(async () => {
    db = await TestDatabase.create('empty');
    migrations = await loadMigrations();
  });
  afterAll(() => db.drop());

  it('apply to an empty database, and a second run applies nothing', async () => {
    const admin = await db.connect();
    const names = migrations.map(migration => migration.name);

    expect(await applyMigrations(admin, migrations)).toEqual({
      applied: names,
      alreadyApplied: [],
    });
    expect(await applyMigrations(admin, migrations)).toEqual({
      applied: [],
      alreadyApplied: names,
    });

    const tables = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class
       WHERE relnamespace = 'uts'::regnamespace AND relkind IN ('r', 'p') AND NOT relispartition
       ORDER BY relname`
    );
    expect(tables.rows.map(row => row.relname)).toEqual(Object.keys(IDENTITY_STORE_TABLES).sort());

    const owners = await admin.query<{ owner: string; count: number }>(
      `SELECT pg_get_userbyid(relowner) AS owner, count(*)::int AS count FROM pg_class
       WHERE relnamespace IN ('uts'::regnamespace, 'uts_read'::regnamespace)
       GROUP BY 1`
    );
    expect(owners.rows.map(row => row.owner)).toEqual(['uts_owner']);
  });

  it('set the 10-second idle limit for every session and take TEMP from PUBLIC', async () => {
    const admin = await db.connect();
    const settings = await admin.query<{ setconfig: string[] }>(
      `SELECT setconfig FROM pg_db_role_setting
       WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND setrole = 0`
    );
    expect(settings.rows).toEqual([{ setconfig: ['idle_in_transaction_session_timeout=10s'] }]);
    const show = await admin.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout'
    );
    expect(show.rows[0].idle_in_transaction_session_timeout).toBe('10s');

    const app = await db.connect('uts_app_a');
    expect(await sqlStateOf(() => app.query('CREATE TEMP TABLE scratch (id int)'))).toBe('42501');
  });

  it('stop when an applied migration changed', async () => {
    const admin = await db.connect();
    const changed = migrations.map((migration, index) =>
      index === migrations.length - 1 ? { ...migration, checksum: '0'.repeat(64) } : migration
    );
    await expect(applyMigrations(admin, changed)).rejects.toThrow(
      new MigrationStateError(`Migration ${migrations.at(-1)?.name} changed after it was applied`)
    );
  });

  it('stop when an applied migration has no file', async () => {
    const admin = await db.connect();
    await expect(applyMigrations(admin, migrations.slice(0, -1))).rejects.toThrow(/has no file/);
  });

  it('stop when a new file sorts before an applied one', async () => {
    const admin = await db.connect();
    const inserted: Migration = { name: '0001_aaa_inserted.sql', sql: 'SELECT 1', checksum: 'x' };
    const withInserted = [...migrations, inserted].sort((a, b) => a.name.localeCompare(b.name));
    await expect(applyMigrations(admin, withInserted)).rejects.toThrow(/sorts before/);
  });

  it('roll back a failing migration and record nothing', async () => {
    const admin = await db.connect();
    const failing: Migration = {
      name: '9999_failing.sql',
      sql: 'CREATE TABLE uts_migrations.partial (id int); SELECT 1 / 0;',
      checksum: 'y',
    };
    await expect(applyMigrations(admin, [...migrations, failing])).rejects.toThrow(
      /division by zero/
    );
    const state = await admin.query<{ table: string | null; recorded: boolean }>(
      `SELECT to_regclass('uts_migrations.partial')::text AS table,
              EXISTS (SELECT 1 FROM uts_migrations.applied WHERE name = '9999_failing.sql') AS recorded`
    );
    expect(state.rows[0]).toEqual({ table: null, recorded: false });
  });

  it('reject a file name outside NNNN_name.sql', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uts-migrations-'));
    try {
      await writeFile(path.join(dir, 'roles.sql'), 'SELECT 1');
      await expect(loadMigrations(dir)).rejects.toThrow(/does not match/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
