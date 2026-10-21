/**
 * Real SQLite execution of production admission SQL builders.
 * Intentionally does NOT mock drizzle — these tests fail if charged-event
 * column counts drift or the NOT EXISTS guard is missing.
 */
import type { BenchmarkPair } from '@kilocode/auto-routing-contracts';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  buildPendingUpsertValues,
  chargedEventInsertStatement,
  claimUserRequestedStatement,
  currentProfileContextFromConfig,
  pendingRegisterUpsertStatement,
  pendingStatusInsertStatement,
  registerProfiles,
} from './profiles';
import { requeueFailedCurrentProfiles } from './db';

const SCHEMA_SQL = `
  CREATE TABLE benchmark_profiles (
    router TEXT NOT NULL DEFAULT 'efficient',
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    failure_reason TEXT,
    invalidated_at TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    platform_requested INTEGER NOT NULL DEFAULT 0,
    user_requested INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (router, model, variant, engine_identity, repetitions)
  );
  CREATE TABLE profile_request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    router TEXT NOT NULL DEFAULT 'efficient',
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL,
    admitted_at TEXT NOT NULL
  );
  CREATE TABLE benchmark_runs (id TEXT PRIMARY KEY, router TEXT, kind TEXT, engine_identity TEXT, repetitions INTEGER);
  CREATE TABLE scheduler_chunks (run_id TEXT, model TEXT, variant TEXT, status TEXT);
`;

type SqlQuery = { sql: string; params: unknown[] };

function toSql(stmt: { toSQL: () => SqlQuery }): SqlQuery {
  return stmt.toSQL();
}

/** node:sqlite Statement.run overloads confuse TS with mixed string/number args. */
function execSql(db: DatabaseSync, sqlText: string, params: readonly unknown[] = []): void {
  db.prepare(sqlText).run(...(params as never[]));
}

function runQuery(db: DatabaseSync, q: SqlQuery): void {
  execSql(db, q.sql, q.params);
}

const eventValues = {
  owner_type: 'user',
  owner_id: 'owner-a',
  router: 'efficient' as const,
  model: 'openai/gpt-4o',
  variant: 'xhigh',
  engine_identity: 'v-test:engine',
  repetitions: 1,
  admitted_at: '2026-07-28T12:00:00.000Z',
};

describe('chargedEventInsertStatement (real SQLite)', () => {
  let db: DatabaseSync;
  // drizzle/d1 only needs a stub for toSQL compilation; we execute via node:sqlite.
  const orm = drizzle({} as D1Database);

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('inserts a charged event when no active current profile row exists', () => {
    runQuery(db, toSql(chargedEventInsertStatement(orm, eventValues)));
    const rows = db.prepare('SELECT * FROM profile_request_events').all() as Array<{
      id: number;
      owner_id: string;
      model: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      owner_id: 'owner-a',
      model: 'openai/gpt-4o',
    });
  });

  it('skips the charge when an active (pending) current profile row exists', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
        (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
      [
        eventValues.model,
        eventValues.variant,
        eventValues.engine_identity,
        eventValues.repetitions,
        '2026-07-28T11:00:00.000Z',
        '2026-07-28T11:00:00.000Z',
      ]
    );

    runQuery(db, toSql(chargedEventInsertStatement(orm, eventValues)));
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({ n: 0 });
  });

  it('skips the charge for running and ready active rows', () => {
    for (const status of ['running', 'ready'] as const) {
      db.exec('DELETE FROM benchmark_profiles; DELETE FROM profile_request_events;');
      execSql(
        db,
        `INSERT INTO benchmark_profiles
          (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'run-1', NULL, ?, ?, NULL)`,
        [
          eventValues.model,
          eventValues.variant,
          eventValues.engine_identity,
          eventValues.repetitions,
          status,
          '2026-07-28T11:00:00.000Z',
          '2026-07-28T11:00:00.000Z',
        ]
      );
      runQuery(db, toSql(chargedEventInsertStatement(orm, eventValues)));
      expect(db.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
        n: 0,
      });
    }
  });

  it('does not charge for an unrelated variant outside the eligible requested pairs', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
      (model, variant, engine_identity, repetitions, status, requested_at, updated_at)
      VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
      [
        eventValues.model,
        eventValues.variant,
        eventValues.engine_identity,
        eventValues.repetitions,
        eventValues.admitted_at,
        eventValues.admitted_at,
      ]
    );
    runQuery(
      db,
      toSql(
        chargedEventInsertStatement(orm, eventValues, [
          { model: eventValues.model, variant: 'xhigh' },
          { model: 'unrelated/model', variant: 'low' },
        ])
      )
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({ n: 0 });
  });

  it('charges when the active row belongs to the other base router', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
        (router, model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
       VALUES ('frontier', ?, ?, ?, ?, 'ready', 'run-1', NULL, ?, ?, NULL)`,
      [
        eventValues.model,
        eventValues.variant,
        eventValues.engine_identity,
        eventValues.repetitions,
        '2026-07-28T11:00:00.000Z',
        '2026-07-28T11:00:00.000Z',
      ]
    );
    runQuery(db, toSql(chargedEventInsertStatement(orm, eventValues)));
    expect(db.prepare('SELECT router FROM profile_request_events').all()).toEqual([
      { router: 'efficient' },
    ]);
  });

  it('charges when the current row is failed (retry path)', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
        (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'failed', 'old', 'boom', ?, ?, NULL)`,
      [
        eventValues.model,
        eventValues.variant,
        eventValues.engine_identity,
        eventValues.repetitions,
        '2026-07-28T11:00:00.000Z',
        '2026-07-28T11:00:00.000Z',
      ]
    );

    runQuery(db, toSql(chargedEventInsertStatement(orm, eventValues)));
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({ n: 1 });
  });
});

describe('registerProfiles multi-variant quota (migrated SQLite)', () => {
  it.each(['pending', 'running', 'ready'] as const)(
    'preserves a healthy %s variant without charging for an unrequested failed variant',
    async status => {
      const sqlite = new DatabaseSync(':memory:');
      try {
        applyBenchmarkMigrations(sqlite);
        const db = sqliteD1(sqlite);
        const orm = drizzle(db);
        const config = { deciderRepetitions: 1 };
        const current = currentProfileContextFromConfig(config);
        const now = new Date('2026-10-18T12:00:00.000Z');
        const requested: BenchmarkPair = { model: 'test/multi-variant', variant: 'high' };
        for (const variant of ['low', 'high'] as const) {
          await pendingStatusInsertStatement(orm, {
            ...buildPendingUpsertValues(
              { model: requested.model, variant },
              current,
              now.toISOString()
            ),
            status: variant === 'high' ? status : 'failed',
            run_id: 'original-run',
          });
        }
        const result = await registerProfiles(db, config, {
          ownerType: 'user',
          ownerId: 'owner-a',
          pairs: [requested],
          retryPairs: [requested],
          now,
        });
        expect(result.statuses).toEqual([{ entry: requested, status, failureReason: null }]);
        expect(
          sqlite
            .prepare('SELECT variant, status, run_id FROM benchmark_profiles ORDER BY variant')
            .all()
        ).toEqual([
          { variant: 'high', status, run_id: 'original-run' },
          { variant: 'low', status: 'failed', run_id: 'original-run' },
        ]);
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
          n: 0,
        });
      } finally {
        sqlite.close();
      }
    }
  );

  it.each([
    ['low', 'high'],
    ['high', 'low'],
  ])(
    'charges once when retrying active failed low and eligible failed high in %s/%s order',
    async (first, second) => {
      const sqlite = new DatabaseSync(':memory:');
      try {
        applyBenchmarkMigrations(sqlite);
        const db = sqliteD1(sqlite);
        const orm = drizzle(db);
        const config = { deciderRepetitions: 1 };
        const current = currentProfileContextFromConfig(config);
        const now = new Date('2026-10-18T12:00:00.000Z');
        const model = 'test/multi-variant';
        for (const variant of ['low', 'high'] as const) {
          const values = buildPendingUpsertValues({ model, variant }, current, now.toISOString());
          await pendingStatusInsertStatement(orm, {
            ...values,
            status: 'failed',
            run_id: 'live-run',
            failure_reason: 'previous failure',
          });
        }
        sqlite
          .prepare(`
        INSERT INTO benchmark_runs (
          id, router, kind, purpose, status, started_at,
          min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity
        ) VALUES ('live-run', 'efficient', 'decider', 'user', 'running', ?, 0.7, 3, 0, ?, ?)
      `)
          .run(now.toISOString(), current.repetitions, current.engineIdentity);
        sqlite
          .prepare(`
        INSERT INTO scheduler_chunks (
          id, run_id, model, variant, providers, rep, chunk, case_ids, status
        ) VALUES ('live-chunk', 'live-run', ?, 'low', '[]', 0, 0, '[]', 'active')
      `)
          .run(model);
        const pairs: BenchmarkPair[] = [first, second].map(variant => ({ model, variant }));
        const result = await registerProfiles(db, config, {
          ownerType: 'user',
          ownerId: 'owner-a',
          pairs,
          retryPairs: pairs,
          now,
        });
        expect(result.statuses).toEqual(
          pairs.map(entry => ({
            entry,
            status: entry.variant === 'low' ? 'failed' : 'pending',
            failureReason: entry.variant === 'low' ? 'previous failure' : null,
          }))
        );
        expect(
          sqlite
            .prepare(
              'SELECT variant, status, run_id, failure_reason FROM benchmark_profiles ORDER BY variant'
            )
            .all()
        ).toEqual([
          { variant: 'high', status: 'pending', run_id: null, failure_reason: null },
          {
            variant: 'low',
            status: 'failed',
            run_id: 'live-run',
            failure_reason: 'previous failure',
          },
        ]);
        expect(sqlite.prepare('SELECT model FROM profile_request_events').all()).toEqual([
          { model },
        ]);
        await registerProfiles(db, config, {
          ownerType: 'user',
          ownerId: 'owner-a',
          pairs,
          retryPairs: pairs,
          now,
        });
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
          n: 1,
        });
      } finally {
        sqlite.close();
      }
    }
  );
});

describe('pendingRegisterUpsertStatement (real SQLite)', () => {
  let db: DatabaseSync;
  const orm = drizzle({} as D1Database);
  const values = buildPendingUpsertValues(
    { model: 'm/a', variant: 'xhigh' },
    { engineIdentity: 'v-test:engine', repetitions: 1 },
    '2026-07-28T12:00:00.000Z'
  );

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('inserts a new pending row', () => {
    runQuery(db, toSql(pendingRegisterUpsertStatement(orm, values)));
    const row = db.prepare('SELECT status, run_id FROM benchmark_profiles').get() as {
      status: string;
      run_id: string | null;
    };
    expect(row).toEqual({ status: 'pending', run_id: null });
  });

  it('transitions failed → pending and clears provenance', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
        (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'failed', 'old-run', 'boom', 't0', 't0', 't1')`,
      [values.model, values.variant, values.engine_identity, values.repetitions]
    );

    runQuery(db, toSql(pendingRegisterUpsertStatement(orm, values)));
    const row = db
      .prepare('SELECT status, run_id, failure_reason, completed_at FROM benchmark_profiles')
      .get();
    expect(row).toEqual({
      status: 'pending',
      run_id: null,
      failure_reason: null,
      completed_at: null,
    });
  });

  it('does not regress running or ready rows', () => {
    for (const status of ['running', 'ready'] as const) {
      db.exec('DELETE FROM benchmark_profiles;');
      execSql(
        db,
        `INSERT INTO benchmark_profiles
          (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'live-run', NULL, 't0', 't0', NULL)`,
        [values.model, values.variant, values.engine_identity, values.repetitions, status]
      );

      runQuery(db, toSql(pendingRegisterUpsertStatement(orm, values)));
      const row = db.prepare('SELECT status, run_id FROM benchmark_profiles').get();
      expect(row).toEqual({ status, run_id: 'live-run' });
    }
  });

  it('does not re-admit or quota-charge a failed entry while its paid claims remain live', async () => {
    execSql(db, "INSERT INTO benchmark_runs VALUES ('old-run', 'efficient', 'decider', ?, ?)", [
      values.engine_identity,
      values.repetitions,
    ]);
    execSql(db, "INSERT INTO scheduler_chunks VALUES ('old-run', ?, ?, 'active')", [
      values.model,
      values.variant,
    ]);
    execSql(
      db,
      "INSERT INTO benchmark_profiles (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at) VALUES (?, ?, ?, ?, 'failed', 'old-run', 't0', 't0')",
      [values.model, values.variant, values.engine_identity, values.repetitions]
    );
    const event = { ...eventValues, model: values.model, variant: values.variant ?? '' };
    runQuery(db, toSql(chargedEventInsertStatement(orm, event)));
    runQuery(db, toSql(pendingRegisterUpsertStatement(orm, values)));
    const binding = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                return {
                  meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(
      await requeueFailedCurrentProfiles(
        binding,
        { engineIdentity: values.engine_identity, repetitions: values.repetitions },
        'user'
      )
    ).toBe(0);
    expect(db.prepare('SELECT status, run_id FROM benchmark_profiles').get()).toEqual({
      status: 'failed',
      run_id: 'old-run',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM profile_request_events').get()).toEqual({
      count: 0,
    });
    execSql(db, "UPDATE scheduler_chunks SET status = 'completed'");
    runQuery(db, toSql(chargedEventInsertStatement(orm, event)));
    runQuery(db, toSql(pendingRegisterUpsertStatement(orm, values)));
    expect(db.prepare('SELECT status, run_id FROM benchmark_profiles').get()).toEqual({
      status: 'pending',
      run_id: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM profile_request_events').get()).toEqual({
      count: 1,
    });
  });

  it('does not let another exact variant block a failed-entry retry', () => {
    execSql(db, "INSERT INTO benchmark_runs VALUES ('old-run', 'efficient', 'decider', ?, ?)", [
      values.engine_identity,
      values.repetitions,
    ]);
    execSql(db, "INSERT INTO scheduler_chunks VALUES ('old-run', ?, 'other-variant', 'queued')", [
      values.model,
    ]);
    execSql(
      db,
      "INSERT INTO benchmark_profiles (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at) VALUES (?, ?, ?, ?, 'failed', 'old-run', 't0', 't0')",
      [values.model, values.variant, values.engine_identity, values.repetitions]
    );
    runQuery(
      db,
      toSql(
        chargedEventInsertStatement(orm, {
          ...eventValues,
          model: values.model,
          variant: values.variant ?? '',
        })
      )
    );
    runQuery(db, toSql(pendingRegisterUpsertStatement(orm, values)));
    expect(db.prepare('SELECT status FROM benchmark_profiles').get()).toEqual({
      status: 'pending',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM profile_request_events').get()).toEqual({
      count: 1,
    });
  });
});

describe('pendingStatusInsertStatement (real SQLite)', () => {
  let db: DatabaseSync;
  const orm = drizzle({} as D1Database);
  const values = buildPendingUpsertValues(
    { model: 'stale/m', variant: null },
    { engineIdentity: 'v-test:engine', repetitions: 1 },
    '2026-07-28T12:00:00.000Z'
  );

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('inserts when absent and does nothing on conflict with a current row', () => {
    runQuery(db, toSql(pendingStatusInsertStatement(orm, values)));
    expect(db.prepare('SELECT status FROM benchmark_profiles').get()).toEqual({
      status: 'pending',
    });

    execSql(db, `UPDATE benchmark_profiles SET status = 'ready', run_id = 'winner'`);
    runQuery(
      db,
      toSql(
        pendingStatusInsertStatement(orm, {
          ...values,
          status: 'pending',
          run_id: null,
          requested_at: '2026-07-28T13:00:00.000Z',
          updated_at: '2026-07-28T13:00:00.000Z',
        })
      )
    );
    expect(db.prepare('SELECT status, run_id FROM benchmark_profiles').get()).toEqual({
      status: 'ready',
      run_id: 'winner',
    });
  });
});

describe('claimUserRequestedStatement (real SQLite)', () => {
  let db: DatabaseSync;
  const orm = drizzle({} as D1Database);
  const current = { engineIdentity: 'v-test:engine', repetitions: 1 };
  const NOW = '2026-07-28T13:00:00.000Z';

  function seed(model: string, engineIdentity: string, userRequested: 0 | 1): void {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
         (model, variant, engine_identity, repetitions, status, requested_at, updated_at,
          platform_requested, user_requested)
       VALUES (?, '', ?, 1, 'ready', '2026-07-28T12:00:00.000Z', '2026-07-28T12:00:00.000Z', 1, ?)`,
      [model, engineIdentity, userRequested]
    );
  }

  function flagOf(model: string): number {
    const row = db
      .prepare(`SELECT user_requested FROM benchmark_profiles WHERE model = ?`)
      .get(model) as { user_requested: number };
    return row.user_requested;
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('records the owner on a row the platform list created', () => {
    // Without this the row stays platform-only. Drop the platform model from
    // the decider list and the pair leaves the registry, even though an owner
    // pool still points at it.
    seed('a/wanted', current.engineIdentity, 0);
    seed('b/untouched', current.engineIdentity, 0);

    runQuery(
      db,
      toSql(claimUserRequestedStatement(orm, [{ model: 'a/wanted', variant: null }], current, NOW))
    );

    expect(flagOf('a/wanted')).toBe(1);
    expect(flagOf('b/untouched')).toBe(0);
  });

  it('does not reach a row measured under another engine identity', () => {
    seed('a/wanted', 'v-other:engine', 0);

    runQuery(
      db,
      toSql(claimUserRequestedStatement(orm, [{ model: 'a/wanted', variant: null }], current, NOW))
    );

    expect(flagOf('a/wanted')).toBe(0);
  });

  it('matches the exact variant, not the model alone', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
         (model, variant, engine_identity, repetitions, status, requested_at, updated_at,
          platform_requested, user_requested)
       VALUES ('a/model', 'high', ?, 1, 'ready', ?, ?, 1, 0)`,
      [current.engineIdentity, NOW, NOW]
    );

    runQuery(
      db,
      toSql(claimUserRequestedStatement(orm, [{ model: 'a/model', variant: null }], current, NOW))
    );

    const row = db
      .prepare(`SELECT user_requested FROM benchmark_profiles WHERE variant = 'high'`)
      .get() as { user_requested: number };
    expect(row.user_requested).toBe(0);
  });

  it('marks only requested pairs of an expanded pool through one JSON parameter', () => {
    const efforts = ['', 'low', 'medium', 'high', 'xhigh'];
    const models = Array.from({ length: 10 }, (_, i) => `vendor/m-${i}`);
    for (const model of models) {
      for (const variant of efforts) {
        execSql(
          db,
          `INSERT INTO benchmark_profiles
             (model, variant, engine_identity, repetitions, status, requested_at, updated_at,
              platform_requested, user_requested)
           VALUES (?, ?, ?, 1, 'ready', ?, ?, 1, 0)`,
          [model, variant, current.engineIdentity, NOW, NOW]
        );
      }
    }
    const requested: BenchmarkPair[] = [
      { model: 'vendor/m-0', variant: null },
      ...models.flatMap(model => ['low', 'high'].map(variant => ({ model, variant }))),
    ];

    const q = toSql(claimUserRequestedStatement(orm, requested, current, NOW));
    expect(q.sql.toLowerCase()).toContain('json_each');
    expect(q.params.length).toBeLessThan(10);
    runQuery(db, q);

    const marked = db
      .prepare(
        `SELECT model, variant FROM benchmark_profiles WHERE user_requested = 1 ORDER BY model, variant`
      )
      .all() as Array<{ model: string; variant: string }>;
    const expected = requested
      .map(pair => ({ model: pair.model, variant: pair.variant ?? '' }))
      .sort((a, b) => a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant));
    expect(marked).toEqual(expected);
  });
});
