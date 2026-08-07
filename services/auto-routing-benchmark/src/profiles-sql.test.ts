/**
 * Real SQLite execution of production admission SQL builders.
 * Intentionally does NOT mock drizzle — these tests fail if charged-event
 * column counts drift or the NOT EXISTS guard is missing.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import {
  buildPendingUpsertValues,
  chargedEventInsertStatement,
  pendingRegisterUpsertStatement,
  pendingStatusInsertStatement,
} from './profiles';

const SCHEMA_SQL = `
  CREATE TABLE benchmark_profiles (
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
    PRIMARY KEY (model, variant, engine_identity, repetitions)
  );
  CREATE TABLE profile_request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL,
    admitted_at TEXT NOT NULL
  );
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

  it('emits column-aligned INSERT...SELECT with NOT EXISTS guard', () => {
    const q = toSql(chargedEventInsertStatement(orm, eventValues));
    expect(q.sql.toLowerCase()).toContain('insert into "profile_request_events"');
    // Full table column list includes autoincrement id.
    expect(q.sql).toMatch(
      /"id".*"owner_type".*"owner_id".*"model".*"variant".*"engine_identity".*"repetitions".*"admitted_at"/s
    );
    expect(q.sql).toMatch(/null\s+as\s+id/i);
    expect(q.sql.toLowerCase()).toContain('where not exists');
    expect(q.sql.toLowerCase()).toContain(`status" in ('pending', 'running', 'ready')`);
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
