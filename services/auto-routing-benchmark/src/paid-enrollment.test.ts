import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { enrollPaidPairStatements } from './db';

const NOW = new Date().toISOString();

/**
 * First-ever paid enrollment of a custom-only pair (R09): the registry row exists so the
 * confirmed request's own run can claim it, it never enters the platform queue, and an
 * existing row — a ready one especially — is never rewritten.
 */
describe('paid pair enrollment (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  afterEach(() => sqlite.close());

  const profile = (model = 'vendor/custom') =>
    sqlite
      .prepare(
        `SELECT model, variant, status, run_id, requested_at, platform_requested,
          user_requested, failure_attempts
        FROM benchmark_profiles WHERE model = ? AND engine_identity = 'engine-1'`
      )
      .get(model) as Record<string, unknown> | undefined;

  it('creates a claimable row with no platform or owner demand', async () => {
    await db.batch(
      enrollPaidPairStatements(db, {
        router: 'efficient',
        engineIdentity: 'engine-1',
        repetitions: 3,
        entries: [{ model: 'vendor/custom', variant: null }],
        requestedAt: NOW,
      })
    );
    // `pending` with both flags off is exactly what the paid run's own claim needs, and what
    // no drain will ever pick up.
    expect(profile()).toEqual({
      model: 'vendor/custom',
      variant: '',
      status: 'pending',
      run_id: null,
      requested_at: NOW,
      platform_requested: 0,
      user_requested: 0,
      failure_attempts: 0,
    });
  });

  it('never rewrites an existing row, so a ready pair is reused not re-queued', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/custom', '', 'engine-1', 3, 'ready', 'run-old', ?, ?, 1, 0)`
      )
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    const before = profile();

    await db.batch(
      enrollPaidPairStatements(db, {
        router: 'efficient',
        engineIdentity: 'engine-1',
        repetitions: 3,
        entries: [{ model: 'vendor/custom', variant: null }],
        requestedAt: NOW,
      })
    );

    expect(profile()).toEqual(before);
  });

  it('enrolls only the pair that is missing, leaving a sibling row alone', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/known', '', 'engine-1', 3, 'pending', NULL, ?, ?, 1, 0)`
      )
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    await db.batch(
      enrollPaidPairStatements(db, {
        router: 'efficient',
        engineIdentity: 'engine-1',
        repetitions: 3,
        entries: [{ model: 'vendor/custom', variant: 'high' }],
        requestedAt: NOW,
      })
    );

    expect(profile('vendor/known')).toMatchObject({ status: 'pending', platform_requested: 1 });
    expect(profile('vendor/custom')).toMatchObject({
      variant: 'high',
      status: 'pending',
      platform_requested: 0,
      user_requested: 0,
    });
  });
});
