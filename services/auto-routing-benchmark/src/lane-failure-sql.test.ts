/**
 * Real SQLite execution of production lane-failure SQL. Intentionally does NOT
 * mock drizzle — these tests fail if the idempotent insert or the run_id +
 * status='running' no-clobber guard is missing or weakened.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { markProfilesFailedForEntriesStatement, recordLaneFailureStatement } from './db';

const SCHEMA_SQL = `
  CREATE TABLE run_lane_failures (
    run_id TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    rep INTEGER NOT NULL DEFAULT 0,
    chunk INTEGER NOT NULL DEFAULT 0,
    shard INTEGER NOT NULL DEFAULT 0,
    failed_at TEXT NOT NULL,
    PRIMARY KEY (run_id, model, variant, rep, chunk, shard)
  );
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
    PRIMARY KEY (model, variant, engine_identity, repetitions)
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

function insertProfile(
  db: DatabaseSync,
  row: {
    model: string;
    variant?: string;
    status: string;
    run_id: string | null;
    failure_reason?: string | null;
  }
): void {
  execSql(
    db,
    `INSERT INTO benchmark_profiles
      (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
     VALUES (?, ?, 'v-test:engine', 1, ?, ?, ?, '2026-08-07T09:00:00.000Z', '2026-08-07T09:00:00.000Z', NULL)`,
    [row.model, row.variant ?? '', row.status, row.run_id, row.failure_reason ?? null]
  );
}

type ProfileRow = {
  model: string;
  status: string;
  run_id: string | null;
  failure_reason: string | null;
  completed_at: string | null;
};

function allProfiles(db: DatabaseSync): ProfileRow[] {
  return db
    .prepare(
      'SELECT model, status, run_id, failure_reason, completed_at FROM benchmark_profiles ORDER BY model, variant'
    )
    .all() as ProfileRow[];
}

const orm = drizzle({} as D1Database);
const now = '2026-08-07T12:00:00.000Z';

describe('recordLaneFailureStatement (real SQLite)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('inserts the lane-death record', () => {
    runQuery(
      db,
      toSql(
        recordLaneFailureStatement(orm, {
          runId: 'run-1',
          model: 'cohere/north-mini-code:free',
          variant: '',
          rep: 0,
          chunk: 27,
          shard: 0,
          failedAtIso: now,
        })
      )
    );

    const rows = db.prepare('SELECT * FROM run_lane_failures').all();
    expect(rows).toEqual([
      {
        run_id: 'run-1',
        model: 'cohere/north-mini-code:free',
        variant: '',
        rep: 0,
        chunk: 27,
        shard: 0,
        failed_at: now,
      },
    ]);
  });

  it('ignores duplicate records (DLQ redelivery must not throw)', () => {
    const row = {
      runId: 'run-1',
      model: 'm/x',
      variant: 'high',
      rep: 1,
      chunk: 3,
      shard: 2,
      failedAtIso: now,
    };
    runQuery(db, toSql(recordLaneFailureStatement(orm, row)));
    runQuery(db, toSql(recordLaneFailureStatement(orm, row)));

    const count = db.prepare('SELECT COUNT(*) AS n FROM run_lane_failures').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('markProfilesFailedForEntriesStatement (real SQLite)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('fails only the listed entries claimed by this run', () => {
    insertProfile(db, { model: 'a/ok', status: 'running', run_id: 'run-1' });
    insertProfile(db, { model: 'b/dead', status: 'running', run_id: 'run-1' });

    runQuery(
      db,
      toSql(
        markProfilesFailedForEntriesStatement(
          orm,
          'run-1',
          [{ model: 'b/dead', variant: '' }],
          'lane dead',
          now
        )
      )
    );

    expect(allProfiles(db)).toEqual([
      {
        model: 'a/ok',
        status: 'running',
        run_id: 'run-1',
        failure_reason: null,
        completed_at: null,
      },
      {
        model: 'b/dead',
        status: 'failed',
        run_id: 'run-1',
        failure_reason: 'lane dead',
        completed_at: now,
      },
    ]);
  });

  it('does not touch rows claimed by a different run or already transitioned', () => {
    insertProfile(db, { model: 'a/other-run', status: 'running', run_id: 'run-2' });
    insertProfile(db, { model: 'b/ready', status: 'ready', run_id: 'run-1' });
    insertProfile(db, { model: 'c/pending', status: 'pending', run_id: null });

    runQuery(
      db,
      toSql(
        markProfilesFailedForEntriesStatement(
          orm,
          'run-1',
          [
            { model: 'a/other-run', variant: '' },
            { model: 'b/ready', variant: '' },
            { model: 'c/pending', variant: '' },
          ],
          'lane dead',
          now
        )
      )
    );

    expect(allProfiles(db)).toEqual([
      {
        model: 'a/other-run',
        status: 'running',
        run_id: 'run-2',
        failure_reason: null,
        completed_at: null,
      },
      {
        model: 'b/ready',
        status: 'ready',
        run_id: 'run-1',
        failure_reason: null,
        completed_at: null,
      },
      {
        model: 'c/pending',
        status: 'pending',
        run_id: null,
        failure_reason: null,
        completed_at: null,
      },
    ]);
  });

  it('matches entries on the exact (model, variant) pair', () => {
    insertProfile(db, { model: 'm/x', variant: 'high', status: 'running', run_id: 'run-1' });
    insertProfile(db, { model: 'm/x', variant: 'low', status: 'running', run_id: 'run-1' });

    runQuery(
      db,
      toSql(
        markProfilesFailedForEntriesStatement(
          orm,
          'run-1',
          [{ model: 'm/x', variant: 'high' }],
          'lane dead',
          now
        )
      )
    );

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/x',
        status: 'failed',
        run_id: 'run-1',
        failure_reason: 'lane dead',
        completed_at: now,
      },
      {
        model: 'm/x',
        status: 'running',
        run_id: 'run-1',
        failure_reason: null,
        completed_at: null,
      },
    ]);
  });
});
