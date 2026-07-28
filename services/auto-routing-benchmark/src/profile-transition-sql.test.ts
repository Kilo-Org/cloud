/**
 * Real SQLite execution of production profile ready/failed transition SQL.
 * Intentionally does NOT mock drizzle — these tests fail if the run_id +
 * status='running' no-clobber guard is missing or weakened.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { markProfilesFailedForRunStatement, markProfilesReadyForRunStatement } from './db';

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
    engine_identity?: string;
    repetitions?: number;
    status: string;
    run_id: string | null;
    failure_reason?: string | null;
    requested_at?: string;
    updated_at?: string;
    completed_at?: string | null;
  }
): void {
  execSql(
    db,
    `INSERT INTO benchmark_profiles
      (model, variant, engine_identity, repetitions, status, run_id, failure_reason, requested_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.model,
      row.variant ?? 'xhigh',
      row.engine_identity ?? 'v-test:engine',
      row.repetitions ?? 1,
      row.status,
      row.run_id,
      row.failure_reason ?? null,
      row.requested_at ?? '2026-07-28T10:00:00.000Z',
      row.updated_at ?? '2026-07-28T10:00:00.000Z',
      row.completed_at ?? null,
    ]
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
      'SELECT model, status, run_id, failure_reason, completed_at FROM benchmark_profiles ORDER BY model'
    )
    .all() as ProfileRow[];
}

describe('markProfilesReadyForRunStatement (real SQLite)', () => {
  let db: DatabaseSync;
  const orm = drizzle({} as D1Database);
  const now = '2026-07-28T12:00:00.000Z';

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('transitions running rows owned by this run_id to ready', () => {
    insertProfile(db, { model: 'm/owned', status: 'running', run_id: 'run-old' });

    runQuery(db, toSql(markProfilesReadyForRunStatement(orm, 'run-old', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/owned',
        status: 'ready',
        run_id: 'run-old',
        failure_reason: null,
        completed_at: now,
      },
    ]);
  });

  it('does not update a newer pending row for the same entry (different run_id)', () => {
    // Same PK identity: entry was re-admitted pending under a new request while
    // an older run finishes. The newer pending row must not be clobbered.
    insertProfile(db, {
      model: 'm/same',
      status: 'pending',
      run_id: 'run-newer',
      requested_at: '2026-07-28T11:00:00.000Z',
      updated_at: '2026-07-28T11:00:00.000Z',
    });

    runQuery(db, toSql(markProfilesReadyForRunStatement(orm, 'run-old', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/same',
        status: 'pending',
        run_id: 'run-newer',
        failure_reason: null,
        completed_at: null,
      },
    ]);
  });

  it('does not overwrite a ready row when a different run completes', () => {
    insertProfile(db, {
      model: 'm/ready',
      status: 'ready',
      run_id: 'run-winner',
      completed_at: '2026-07-28T09:00:00.000Z',
    });

    runQuery(db, toSql(markProfilesReadyForRunStatement(orm, 'run-other', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/ready',
        status: 'ready',
        run_id: 'run-winner',
        failure_reason: null,
        completed_at: '2026-07-28T09:00:00.000Z',
      },
    ]);
  });
});

describe('markProfilesFailedForRunStatement (real SQLite)', () => {
  let db: DatabaseSync;
  const orm = drizzle({} as D1Database);
  const now = '2026-07-28T12:00:00.000Z';

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('transitions running rows owned by this run_id to failed', () => {
    insertProfile(db, { model: 'm/owned', status: 'running', run_id: 'run-old' });

    runQuery(db, toSql(markProfilesFailedForRunStatement(orm, 'run-old', 'enqueue failed', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/owned',
        status: 'failed',
        run_id: 'run-old',
        failure_reason: 'enqueue failed',
        completed_at: now,
      },
    ]);
  });

  it('does not update a newer pending row when an older run fails', () => {
    insertProfile(db, {
      model: 'm/same',
      status: 'pending',
      run_id: 'run-newer',
      requested_at: '2026-07-28T11:00:00.000Z',
      updated_at: '2026-07-28T11:00:00.000Z',
    });

    runQuery(db, toSql(markProfilesFailedForRunStatement(orm, 'run-old', 'boom', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/same',
        status: 'pending',
        run_id: 'run-newer',
        failure_reason: null,
        completed_at: null,
      },
    ]);
  });

  it('does not overwrite a ready row when a different run fails', () => {
    insertProfile(db, {
      model: 'm/ready',
      status: 'ready',
      run_id: 'run-winner',
      completed_at: '2026-07-28T09:00:00.000Z',
    });

    runQuery(db, toSql(markProfilesFailedForRunStatement(orm, 'run-other', 'late fail', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/ready',
        status: 'ready',
        run_id: 'run-winner',
        failure_reason: null,
        completed_at: '2026-07-28T09:00:00.000Z',
      },
    ]);
  });

  it('running-scoped update only affects this run_id among mixed rows', () => {
    insertProfile(db, { model: 'm/a', status: 'running', run_id: 'run-old' });
    insertProfile(db, {
      model: 'm/b',
      status: 'pending',
      run_id: null,
      requested_at: '2026-07-28T11:00:00.000Z',
    });
    insertProfile(db, {
      model: 'm/c',
      status: 'ready',
      run_id: 'run-other',
      completed_at: '2026-07-28T08:00:00.000Z',
    });
    insertProfile(db, { model: 'm/d', status: 'running', run_id: 'run-other' });

    runQuery(db, toSql(markProfilesFailedForRunStatement(orm, 'run-old', 'timeout', now)));

    expect(allProfiles(db)).toEqual([
      {
        model: 'm/a',
        status: 'failed',
        run_id: 'run-old',
        failure_reason: 'timeout',
        completed_at: now,
      },
      {
        model: 'm/b',
        status: 'pending',
        run_id: null,
        failure_reason: null,
        completed_at: null,
      },
      {
        model: 'm/c',
        status: 'ready',
        run_id: 'run-other',
        failure_reason: null,
        completed_at: '2026-07-28T08:00:00.000Z',
      },
      {
        model: 'm/d',
        status: 'running',
        run_id: 'run-other',
        failure_reason: null,
        completed_at: null,
      },
    ]);
  });
});
