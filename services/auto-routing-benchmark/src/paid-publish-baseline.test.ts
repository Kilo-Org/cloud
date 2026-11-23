import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { getLatestRoutingTable, recordPublishedDesiredPairs } from './db';

const NOW = new Date().toISOString();

/**
 * The publication baseline on real migrations: an unchanged pool must never be rebuilt —
 * including when a desired pair is absent from the ranked routes because its probe results
 * are incomplete — while a real membership change still applies.
 */
describe('routing-table publication baseline (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    // A legacy publication: an artifact with one ranked pair, no recorded membership.
    sqlite
      .prepare(
        `INSERT INTO routing_tables (run_id, router, published_at, generated_at, min_accuracy,
          switch_cost_factor, source)
        VALUES ('legacy-version', 'efficient', ?, ?, 0.7, 3, 'benchmark')`
      )
      .run(NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO routing_table_candidates (run_id, route_key, rank, model, variant, accuracy,
          avg_cost_usd, meets_threshold, reasoning_effort)
        VALUES ('legacy-version', 'implementation/code_generation', 0, 'vendor/ranked', '', 0.8,
          0.01, 1, NULL)`
      )
      .run();
  });

  afterEach(() => sqlite.close());

  it('records the configured membership on a legacy publication without touching the artifact', async () => {
    const before = sqlite
      .prepare('SELECT run_id, published_at, generated_at FROM routing_tables')
      .all();
    const candidatesBefore = sqlite
      .prepare('SELECT run_id, route_key, rank, model FROM routing_table_candidates')
      .all();

    const seeded = await recordPublishedDesiredPairs(db, 'legacy-version', [
      'vendor/ranked',
      'vendor/incomplete-probes',
    ]);
    expect(seeded).toBe(1);

    const latest = await getLatestRoutingTable(db, 'efficient');
    expect(latest?.desiredPairs).toEqual(['vendor/incomplete-probes', 'vendor/ranked']);
    // The measured artifact is untouched: only the membership column moved.
    expect(
      sqlite.prepare('SELECT run_id, published_at, generated_at FROM routing_tables').all()
    ).toEqual(before);
    expect(
      sqlite.prepare('SELECT run_id, route_key, rank, model FROM routing_table_candidates').all()
    ).toEqual(candidatesBefore);
  });

  it('seeds once and never overwrites an existing baseline', async () => {
    expect(await recordPublishedDesiredPairs(db, 'legacy-version', ['vendor/a'])).toBe(1);
    expect(await recordPublishedDesiredPairs(db, 'legacy-version', ['vendor/b'])).toBe(0);
    expect((await getLatestRoutingTable(db, 'efficient'))?.desiredPairs).toEqual(['vendor/a']);
  });

  it('writes the recorded membership through saveRoutingTable so a republish carries it', async () => {
    // The column round-trips, which is what the publish guard compares against.
    const latest = await getLatestRoutingTable(db, 'efficient');
    expect(latest?.desiredPairs).toBeNull();
    await recordPublishedDesiredPairs(db, 'legacy-version', ['vendor/ranked']);
    expect((await getLatestRoutingTable(db, 'efficient'))?.desiredPairs).toEqual(['vendor/ranked']);
  });
});
