import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { collapsePendingOwnerAliasRows, listPendingCurrentProfiles } from './db';
import { BenchmarkModelCatalogSchema, concreteAliasPair } from './platform-models';
import { variantFromStorage } from './reasoning-effort';

const CURRENT = { engineIdentity: 'v-test:engine', repetitions: 1 };
const EARLIER = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-16T00:00:00.000Z';

const catalog = BenchmarkModelCatalogSchema.parse({
  data: [
    {
      id: 'vendor/flash',
      opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
    },
    { id: '~vendor/flash-latest', alias_target: 'vendor/flash' },
    { id: '~vendor/gone-latest', alias_target: 'vendor/gone' },
  ],
});

let sqlite: DatabaseSync;
let binding: D1Database;

function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sqlText: string) {
      const statement = db.prepare(sqlText);
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              statement.run(...(params as never[]));
              return { success: true, results: [] };
            },
            async raw() {
              return statement.all(...(params as never[])).map(row => Object.values(row));
            },
          };
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) await statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return [];
    },
  } as unknown as D1Database;
}

function seed(
  model: string,
  variant: string,
  status: string,
  flags: { platform?: 0 | 1; user?: 0 | 1 } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO benchmark_profiles
         (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at,
          platform_requested, user_requested)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      model,
      variant,
      CURRENT.engineIdentity,
      status,
      status === 'pending' ? null : 'run-old',
      EARLIER,
      EARLIER,
      flags.platform ?? 0,
      flags.user ?? 1
    );
}

function rows() {
  return sqlite
    .prepare(
      `SELECT model, variant, status, run_id, user_requested, platform_requested
       FROM benchmark_profiles ORDER BY model, variant`
    )
    .all();
}

async function collapse(): Promise<void> {
  const pending = await listPendingCurrentProfiles(binding, CURRENT, 'user');
  const aliases = pending.flatMap(row => {
    const target = concreteAliasPair(catalog, {
      model: row.model,
      variant: variantFromStorage(row.variant),
    });
    return target === undefined
      ? []
      : [{ alias: { model: row.model, variant: row.variant }, target }];
  });
  await collapsePendingOwnerAliasRows(binding, CURRENT, aliases, NOW);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE benchmark_profiles (
      router TEXT NOT NULL DEFAULT 'efficient',
      model TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT '',
      engine_identity TEXT NOT NULL,
      repetitions INTEGER NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      failure_reason TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      platform_requested INTEGER NOT NULL DEFAULT 0,
      user_requested INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (router, model, variant, engine_identity, repetitions)
    );
  `);
  binding = d1(sqlite);
});

describe('collapsePendingOwnerAliasRows (real SQLite)', () => {
  it('converts a pending owner alias row to its concrete pair exactly once', async () => {
    seed('~vendor/flash-latest', 'high', 'pending');

    await collapse();
    const converted = rows();
    await collapse();

    expect(rows()).toEqual(converted);
    expect(converted).toEqual([
      {
        model: 'vendor/flash',
        variant: 'high',
        status: 'pending',
        run_id: null,
        user_requested: 1,
        platform_requested: 0,
      },
      {
        model: '~vendor/flash-latest',
        variant: 'high',
        status: 'pending',
        run_id: null,
        user_requested: 0,
        platform_requested: 0,
      },
    ]);
    expect(await listPendingCurrentProfiles(binding, CURRENT, 'user')).toEqual([
      { model: 'vendor/flash', variant: 'high', requested_at: EARLIER },
    ]);
  });

  it('collapses an alias into an owner or platform row for its target, leaving one measurement', async () => {
    seed('~vendor/flash-latest', 'high', 'pending');
    seed('vendor/flash', 'high', 'pending', { platform: 1, user: 0 });

    await collapse();

    expect(await listPendingCurrentProfiles(binding, CURRENT, 'user')).toEqual([
      { model: 'vendor/flash', variant: 'high', requested_at: EARLIER },
    ]);
    expect(await listPendingCurrentProfiles(binding, CURRENT, 'platform')).toEqual([
      { model: 'vendor/flash', variant: 'high', requested_at: EARLIER },
    ]);
  });

  it('keeps an alias whose target is missing from the catalog', async () => {
    seed('~vendor/gone-latest', '', 'pending');

    await collapse();

    expect(await listPendingCurrentProfiles(binding, CURRENT, 'user')).toEqual([
      { model: '~vendor/gone-latest', variant: '', requested_at: EARLIER },
    ]);
  });

  it('drops an alias variant its target no longer offers without creating a row', async () => {
    seed('~vendor/flash-latest', 'low', 'pending');

    await collapse();

    expect(rows()).toEqual([expect.objectContaining({ model: '~vendor/flash-latest' })]);
    expect(await listPendingCurrentProfiles(binding, CURRENT, 'user')).toEqual([]);
  });

  it('never moves a claimed, failed or measured alias row', async () => {
    seed('~vendor/flash-latest', 'high', 'running');
    const before = rows();

    await collapsePendingOwnerAliasRows(
      binding,
      CURRENT,
      [
        {
          alias: { model: '~vendor/flash-latest', variant: 'high' },
          target: { model: 'vendor/flash', variant: 'high' },
        },
      ],
      NOW
    );

    expect(rows()).toEqual(before);
  });
});
