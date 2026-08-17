/**
 * Real SQLite execution of the 0010 data migration.
 *
 * The migration decides which already-paid-for measurements become registry
 * rows. Adopting too little re-benchmarks models at full cost; adopting too
 * much publishes a half-measured model as a finished candidate. Both are
 * expensive, so it runs against real SQLite, and against the file that ships.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

// The dataset size the migration hardcodes. A whole pair grades every case,
// once per repetition.
const CASES = 180;

const MIGRATION_SQL = readFileSync(
  join(import.meta.dirname, '../migrations/0010_breezy_pet_avengers.sql'),
  'utf8'
);

/** Schema as of 0009 — what the migration is applied on top of. */
const SCHEMA_SQL = `
  CREATE TABLE benchmark_config (
    id INTEGER PRIMARY KEY,
    max_concurrency INTEGER NOT NULL DEFAULT 10
  );
  CREATE TABLE benchmark_runs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    engine_identity TEXT NOT NULL DEFAULT '',
    repetitions INTEGER NOT NULL DEFAULT 1,
    purpose TEXT NOT NULL DEFAULT 'platform'
  );
  CREATE UNIQUE INDEX UQ_benchmark_runs_one_running_per_kind
    ON benchmark_runs (kind) WHERE "benchmark_runs"."status" = 'running';
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
  CREATE TABLE model_summaries (
    run_id TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    route_key TEXT NOT NULL,
    cases INTEGER NOT NULL,
    PRIMARY KEY (run_id, model, variant, route_key)
  );
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
`;

const ENGINE = 'v1:testengine';

let db: DatabaseSync;

function exec(sqlText: string, params: readonly unknown[] = []): void {
  db.prepare(sqlText).run(...(params as never[]));
}

function seedRun(
  id: string,
  status: 'running' | 'completed' | 'failed',
  purpose: 'platform' | 'profile',
  startedAt: string
): void {
  exec(
    `INSERT INTO benchmark_runs (id, kind, status, started_at, completed_at, engine_identity, repetitions, purpose)
     VALUES (?, 'decider', ?, ?, ?, ?, 1, ?)`,
    [id, status, startedAt, status === 'running' ? null : startedAt, ENGINE, purpose]
  );
}

/** One summary row carrying the whole pair's case count — the migration sums it. */
function seedSummary(runId: string, model: string, cases: number): void {
  exec(
    `INSERT INTO model_summaries (run_id, model, variant, route_key, cases) VALUES (?, ?, '', 'route-a', ?)`,
    [runId, model, cases]
  );
}

function seedProfile(model: string, status: string, runId: string | null): void {
  exec(
    `INSERT INTO benchmark_profiles
       (model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at)
     VALUES (?, '', ?, 1, ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    [model, ENGINE, status, runId]
  );
}

function profileRow(model: string): {
  status: string;
  run_id: string | null;
  platform_requested: number;
  user_requested: number;
} {
  return db
    .prepare(
      `SELECT status, run_id, platform_requested, user_requested FROM benchmark_profiles WHERE model = ?`
    )
    .get(model) as never;
}

function applyMigration(): void {
  for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) {
    db.exec(statement);
  }
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
});

describe('0010 registry backfill (real SQLite)', () => {
  it('adopts a whole pair out of a run that failed, and leaves the broken ones alone', () => {
    // The run this is written for: it timed out, so the old code failed all of
    // its entries even though most of them had graded every case.
    seedRun('user-run', 'failed', 'profile', '2026-08-07T13:00:00.000Z');
    seedSummary('user-run', 'm/whole', CASES);
    seedSummary('user-run', 'm/partial', CASES - 90);
    seedSummary('user-run', 'm/dead-lane', CASES);
    exec(
      `INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at)
       VALUES ('user-run', 'm/dead-lane', '', 0, 0, 0, '2026-08-07T13:30:00.000Z')`
    );
    seedProfile('m/whole', 'failed', 'user-run');
    seedProfile('m/partial', 'failed', 'user-run');
    seedProfile('m/dead-lane', 'failed', 'user-run');

    applyMigration();

    expect(profileRow('m/whole')).toMatchObject({
      status: 'ready',
      run_id: 'user-run',
      platform_requested: 0,
      user_requested: 1,
    });
    // Publishing either of these would serve a model that was never fully graded.
    expect(profileRow('m/partial').status).toBe('failed');
    expect(profileRow('m/dead-lane').status).toBe('failed');
  });

  it('creates a platform-flagged row for a pair no owner pool asked for', () => {
    seedRun('plat-run', 'completed', 'platform', '2026-08-05T00:00:00.000Z');
    seedSummary('plat-run', 'm/platform-only', CASES);

    applyMigration();

    expect(profileRow('m/platform-only')).toMatchObject({
      status: 'ready',
      run_id: 'plat-run',
      platform_requested: 1,
      user_requested: 0,
    });
  });

  it('keeps the owner flag when a platform run adopts a pair a pool had queued', () => {
    seedRun('plat-run', 'completed', 'platform', '2026-08-05T00:00:00.000Z');
    seedSummary('plat-run', 'm/both', CASES);
    seedProfile('m/both', 'pending', null);

    applyMigration();

    expect(profileRow('m/both')).toMatchObject({
      status: 'ready',
      platform_requested: 1,
      user_requested: 1,
    });
  });

  it('takes the newest run when several measured the same pair', () => {
    seedRun('old-run', 'completed', 'platform', '2026-08-01T00:00:00.000Z');
    seedRun('new-run', 'failed', 'profile', '2026-08-06T00:00:00.000Z');
    seedSummary('old-run', 'm/twice', CASES);
    seedSummary('new-run', 'm/twice', CASES);

    applyMigration();

    expect(profileRow('m/twice').run_id).toBe('new-run');
  });

  it('does not touch rows a live run still owns', () => {
    // A running run settles its own entries. Readying them here would hand the
    // same rows to two writers.
    //
    // The older completed run is the point: it makes this pair adoptable, so
    // only the upsert's status guard keeps the live claim. Without it the row
    // is re-pointed at the old run while the live run is still measuring it.
    seedRun('live-run', 'running', 'profile', '2026-08-07T19:42:00.000Z');
    seedSummary('live-run', 'm/in-flight', CASES);
    seedProfile('m/in-flight', 'running', 'live-run');
    seedRun('older-run', 'completed', 'platform', '2026-08-01T00:00:00.000Z');
    seedSummary('older-run', 'm/in-flight', CASES);

    applyMigration();

    expect(profileRow('m/in-flight')).toMatchObject({
      status: 'running',
      run_id: 'live-run',
    });
  });

  it('leaves an already-ready row on its own provenance', () => {
    seedRun('plat-run', 'completed', 'platform', '2026-08-05T00:00:00.000Z');
    seedSummary('plat-run', 'm/settled', CASES);
    seedProfile('m/settled', 'ready', 'earlier-run');

    applyMigration();

    expect(profileRow('m/settled').run_id).toBe('earlier-run');
  });

  it('renames the profile purpose to the queue it drains', () => {
    seedRun('user-run', 'completed', 'profile', '2026-08-07T09:00:00.000Z');

    applyMigration();

    const row = db.prepare(`SELECT purpose FROM benchmark_runs WHERE id = 'user-run'`).get() as {
      purpose: string;
    };
    expect(row.purpose).toBe('user');
  });
});
