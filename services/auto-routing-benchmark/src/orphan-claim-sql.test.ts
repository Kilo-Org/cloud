/**
 * Real SQLite execution of the orphaned-claim reaper.
 *
 * This is the statement that decides whether a measurement gets thrown away and
 * paid for a second time, so it runs against real SQLite rather than a stub. It
 * must reap rows whose run is gone or finished, and it must NOT touch a row
 * whose run is still going, nor one being settled right now — a run marks itself
 * completed just before it settles its rows.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { failOrphanedRunningProfilesStatement } from './db';

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
  CREATE TABLE benchmark_runs (
    -- NOT NULL matches production. Without it SQLite allows a NULL id, and a
    -- NULL in the subquery makes NOT IN match nothing — the reaper would stop
    -- reaping and the fixture would hide it.
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    min_accuracy REAL NOT NULL,
    switch_cost_factor REAL NOT NULL,
    best_accuracy_switch_threshold REAL NOT NULL DEFAULT 0.05,
    max_concurrency INTEGER NOT NULL,
    benchmark_user_id TEXT,
    benchmark_org_id TEXT,
    repetitions INTEGER NOT NULL DEFAULT 1,
    classifier_max_p95_latency_ms INTEGER,
    engine_identity TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT 'platform'
  );
`;

// The reaper only considers rows untouched since OLDER_THAN (now minus the
// stale-run age). JUST_NOW sits after it, LONG_AGO before it.
const OLDER_THAN = '2026-07-28T12:00:00.000Z';
const LONG_AGO = '2026-07-28T04:00:00.000Z';
const JUST_NOW = '2026-07-28T17:59:59.000Z';
const NOW = '2026-07-28T18:00:00.000Z';

let db: DatabaseSync;

function exec(sqlText: string, params: readonly unknown[] = []): void {
  db.prepare(sqlText).run(...(params as never[]));
}

function seedRun(id: string, status: 'running' | 'completed' | 'failed'): void {
  exec(
    `INSERT INTO benchmark_runs
      (id, kind, status, started_at, min_accuracy, switch_cost_factor, max_concurrency, repetitions)
     VALUES (?, 'decider', ?, ?, 0.7, 3, 100, 1)`,
    [id, status, LONG_AGO]
  );
}

function seedClaim(model: string, runId: string | null, updatedAt: string): void {
  exec(
    `INSERT INTO benchmark_profiles
      (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at)
     VALUES (?, '', 'v-test:engine', 1, 'running', ?, ?, ?)`,
    [model, runId, LONG_AGO, updatedAt]
  );
}

function statusOf(model: string): string {
  const row = db.prepare(`SELECT status FROM benchmark_profiles WHERE model = ?`).get(model) as {
    status: string;
  };
  return row.status;
}

function reap(): void {
  const query = failOrphanedRunningProfilesStatement(
    drizzle({} as D1Database),
    'orphaned',
    OLDER_THAN,
    NOW
  ).toSQL();
  exec(query.sql, query.params);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
});

describe('failOrphanedRunningProfilesStatement (real SQLite)', () => {
  it('reaps a claim whose run row was never written', () => {
    // startRun claims the registry rows before it writes the run. A failure in
    // between leaves rows pointing at a run id that does not exist, and a
    // claimed platform row keeps the queue unsettled forever.
    seedClaim('m/never-inserted', 'run-that-does-not-exist', LONG_AGO);

    reap();

    expect(statusOf('m/never-inserted')).toBe('failed');
  });

  it('reaps a claim left behind by a run that already finished', () => {
    seedRun('run-done', 'completed');
    seedRun('run-dead', 'failed');
    seedClaim('m/after-complete', 'run-done', LONG_AGO);
    seedClaim('m/after-fail', 'run-dead', LONG_AGO);

    reap();

    expect(statusOf('m/after-complete')).toBe('failed');
    expect(statusOf('m/after-fail')).toBe('failed');
  });

  it('leaves a claim held by a run that is still going', () => {
    seedRun('run-live', 'running');
    seedClaim('m/in-flight', 'run-live', LONG_AGO);

    reap();

    expect(statusOf('m/in-flight')).toBe('running');
  });

  it('leaves a claim that was touched recently', () => {
    // A run marks itself completed and then settles its rows. Without the age
    // guard this window would fail entries that are fully measured, and they
    // would be requeued and benchmarked again at full cost.
    seedRun('run-finalizing', 'completed');
    seedClaim('m/being-settled', 'run-finalizing', JUST_NOW);

    reap();

    expect(statusOf('m/being-settled')).toBe('running');
  });

  it('leaves rows that are not claimed at all', () => {
    exec(
      `INSERT INTO benchmark_profiles
        (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at)
       VALUES ('m/pending', '', 'v-test:engine', 1, 'pending', NULL, ?, ?)`,
      [LONG_AGO, LONG_AGO]
    );
    exec(
      `INSERT INTO benchmark_profiles
        (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at)
       VALUES ('m/ready', '', 'v-test:engine', 1, 'ready', 'run-old', ?, ?)`,
      [LONG_AGO, LONG_AGO]
    );

    reap();

    expect(statusOf('m/pending')).toBe('pending');
    expect(statusOf('m/ready')).toBe('ready');
  });
});
