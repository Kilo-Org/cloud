import { env, reset, runInDurableObject } from 'cloudflare:test';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import migrations from '../../src/control-plane/sandbox/drizzle/migrations.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;

type ColumnSignature = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const sqliteMaster = sqliteTable('sqlite_master', {
  name: text('name').notNull(),
  type: text('type').notNull(),
});
const migrationLog = sqliteTable('__drizzle_migrations', {
  hash: text('hash').notNull(),
  created_at: integer('created_at').notNull(),
});
type MigrationDb = ReturnType<typeof drizzle>;

const EXPECTED_ALLOCATION_COLUMNS: ColumnSignature[] = [
  { name: 'allocation_id', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'connection_id', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'create_deadline_at', type: 'integer', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'first_connect_deadline_at', type: 'integer', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'id', type: 'text', notnull: 1, dflt_value: null, pk: 1 },
  { name: 'last_activity_at', type: 'integer', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'last_frame_at', type: 'integer', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'provider_pin', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'provider_ref', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'state', type: 'text', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'stop_at', type: 'integer', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'stop_attempt', type: 'integer', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'stop_pending', type: 'integer', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'unconfirmed_provider_ref', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'wrapper_id', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
];

const EXPECTED_ROUTES_COLUMNS: ColumnSignature[] = [
  { name: 'attempt_deadline_at', type: 'integer', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'attempt_id', type: 'text', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'credential_source', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'grant', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'reason', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'session_id', type: 'text', notnull: 1, dflt_value: null, pk: 1 },
  { name: 'spec', type: 'text', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'state', type: 'text', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'updated_at', type: 'integer', notnull: 1, dflt_value: null, pk: 0 },
];

const OLD_FOUR_MIGRATIONS = {
  journal: {
    entries: [
      { idx: 0, when: 1790455891314, tag: '0000_sandbox_control_v2', breakpoints: true },
      { idx: 1, when: 1790457686115, tag: '0001_fantastic_stranger', breakpoints: true },
      { idx: 2, when: 1790463007428, tag: '0002_optimal_demogoblin', breakpoints: true },
      { idx: 3, when: 1790511032804, tag: '0003_unconfirmed_provider_ref', breakpoints: true },
    ],
  },
  migrations: {
    m0000: [
      'CREATE TABLE `allocation` (',
      '  `id` text PRIMARY KEY NOT NULL,',
      '  `state` text NOT NULL,',
      '  `allocation_id` text,',
      '  `connection_id` text,',
      '  `provider_ref` text,',
      '  `wrapper_id` text,',
      '  `last_frame_at` integer,',
      '  `last_activity_at` integer,',
      '  `create_deadline_at` integer,',
      '  `first_connect_deadline_at` integer,',
      '  `stop_attempt` integer NOT NULL,',
      '  `stop_pending` integer NOT NULL,',
      '  `stop_at` integer,',
      '  `provider_pin` text',
      ');',
      '--> statement-breakpoint',
      'CREATE TABLE `routes` (',
      '  `session_id` text PRIMARY KEY NOT NULL,',
      '  `spec` text NOT NULL,',
      '  `state` text NOT NULL,',
      '  `attempt_id` text NOT NULL,',
      '  `attempt_deadline_at` integer,',
      '  `reason` text,',
      '  `updated_at` integer NOT NULL',
      ');',
    ].join('\n'),
    m0001: 'ALTER TABLE `routes` ADD `grant` text;',
    m0002: 'ALTER TABLE `routes` ADD `credential_source` text;',
    m0003: 'ALTER TABLE `allocation` ADD `unconfirmed_provider_ref` text;',
  },
};

function newSandboxStub(): DurableObjectStub<SandboxControlV2> {
  return sandboxes.get(sandboxes.idFromName(`migration_${crypto.randomUUID()}`));
}

function clearSchema(db: MigrationDb): void {
  db.run(sql`DROP TABLE IF EXISTS allocation`);
  db.run(sql`DROP TABLE IF EXISTS routes`);
  db.run(sql`DROP TABLE IF EXISTS __drizzle_migrations`);
}

function appTableNames(db: MigrationDb): string[] {
  return db
    .select({ name: sqliteMaster.name })
    .from(sqliteMaster)
    .where(eq(sqliteMaster.type, 'table'))
    .orderBy(asc(sqliteMaster.name))
    .all()
    .map(row => row.name)
    .filter(name => !name.startsWith('_') && !name.startsWith('sqlite_'));
}

function columnSignatures(db: MigrationDb, table: string): ColumnSignature[] {
  return db
    .select({
      name: sql<string>`name`,
      type: sql<string>`type`,
      notnull: sql<number>`"notnull"`,
      dflt_value: sql<string | null>`dflt_value`,
      pk: sql<number>`pk`,
    })
    .from(sql`pragma_table_info(${table})`)
    .all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type: type.toLowerCase(),
      notnull,
      dflt_value,
      pk,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function appliedMigrations(db: MigrationDb): { hash: string; created_at: number }[] {
  return db.select().from(migrationLog).orderBy(asc(migrationLog.created_at)).all();
}

afterEach(async () => {
  await reset();
});

describe('sandbox control V2 consolidated migrations', () => {
  it('applies the consolidated migration to a fresh database', async () => {
    const stub = newSandboxStub();
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      clearSchema(db);

      await migrate(db, migrations);

      expect(appTableNames(db)).toEqual(['allocation', 'routes']);
      expect(columnSignatures(db, 'allocation')).toEqual(EXPECTED_ALLOCATION_COLUMNS);
      expect(columnSignatures(db, 'routes')).toEqual(EXPECTED_ROUTES_COLUMNS);
      expect(appliedMigrations(db)).toEqual([{ hash: '', created_at: 1790455891314 }]);
    });
  });

  it('skips the consolidated migration on a database already migrated by the old four, preserving data', async () => {
    const stub = newSandboxStub();
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      clearSchema(db);
      await migrate(db, OLD_FOUR_MIGRATIONS);

      const oldAllocationColumns = columnSignatures(db, 'allocation');
      const oldRoutesColumns = columnSignatures(db, 'routes');
      const oldApplied = appliedMigrations(db);
      expect(oldApplied.at(-1)?.created_at).toBe(1790511032804);

      await db.insert(allocationTable).values({
        id: 'current',
        state: 'stopped',
        stop_attempt: 0,
        stop_pending: false,
        unconfirmed_provider_ref: '{"fixture":"old-provider-ref"}',
      });
      await db.insert(routesTable).values({
        session_id: 'workspace_old',
        spec: '{"kind":"old"}',
        state: 'routed',
        attempt_id: 'attempt_old',
        updated_at: 111,
        grant: '{"fixture":"old-grant"}',
        credential_source: '{"fixture":"old-credential-source"}',
      });

      await expect(migrate(db, migrations)).resolves.toBeUndefined();

      expect(appliedMigrations(db)).toEqual(oldApplied);
      expect(columnSignatures(db, 'allocation')).toEqual(oldAllocationColumns);
      expect(columnSignatures(db, 'routes')).toEqual(oldRoutesColumns);
      expect(db.select().from(allocationTable).get()).toMatchObject({
        id: 'current',
        state: 'stopped',
        unconfirmed_provider_ref: '{"fixture":"old-provider-ref"}',
      });
      expect(db.select().from(routesTable).get()).toMatchObject({
        session_id: 'workspace_old',
        attempt_id: 'attempt_old',
        updated_at: 111,
        grant: '{"fixture":"old-grant"}',
        credential_source: '{"fixture":"old-credential-source"}',
      });
    });
  });
});
