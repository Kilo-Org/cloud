import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { reuseDeciderCaseResults } from './db';
import { BenchmarkModelCatalogSchema } from './platform-models';
import { ProfileRefreshConflictError, refreshCurrentProfiles } from './profile-refresh';

const measuredAt = '2026-01-01T00:00:00.000Z';
const refreshedAt = '2026-01-02T00:00:00.000Z';
const current = { router: 'efficient' as const, engineIdentity: 'test-engine', repetitions: 1 };
const catalog = BenchmarkModelCatalogSchema.parse({
  data: [{ id: 'vendor/selected' }, { id: 'vendor/other' }],
});
let sqlite: DatabaseSync;
let db: D1Database;

function seedRun(id: string, startedAt = measuredAt) {
  sqlite
    .prepare(`INSERT INTO benchmark_runs (
    id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
    max_concurrency, repetitions, engine_identity
  ) VALUES (?, 'efficient', 'decider', 'user', 'completed', ?, 0.7, 3, 0, 1, 'test-engine')`)
    .run(id, startedAt);
}

function seedProfile(model: string, status = 'ready') {
  sqlite
    .prepare(`INSERT INTO benchmark_profiles (
    router, model, variant, engine_identity, repetitions, status, run_id,
    requested_at, updated_at, platform_requested, user_requested
  ) VALUES ('efficient', ?, '', 'test-engine', 1, ?, 'source', ?, ?, 0, 1)`)
    .run(model, status, measuredAt, measuredAt);
}

function seedCase(model: string, error: string | null = null) {
  sqlite
    .prepare(`INSERT INTO case_results (
    run_id, model, variant, case_id, score, latency_ms, exit_code, error, rep
  ) VALUES ('source', ?, '', 'case-a', 1, 10, ?, ?, 0)`)
    .run(model, error ? 1 : 0, error);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  db = sqliteD1(sqlite);
  seedRun('source');
});
afterEach(() => sqlite.close());

describe('targeted benchmark refresh', () => {
  it('invalidates only selected current pairs and leaves unavailable models failed', async () => {
    seedProfile('vendor/selected');
    seedProfile('vendor/removed');
    seedProfile('vendor/other');
    sqlite
      .prepare(`INSERT INTO benchmark_profiles (
      router, model, variant, engine_identity, repetitions, status, requested_at, updated_at
    ) VALUES ('efficient', 'vendor/selected', '', 'older-engine', 1, 'ready', ?, ?)`)
      .run(measuredAt, measuredAt);
    const result = await refreshCurrentProfiles(
      db,
      {
        ...current,
        mode: 'refresh',
        entries: [
          { model: 'vendor/selected', variant: null },
          { model: 'vendor/removed', variant: null },
        ],
      },
      catalog,
      refreshedAt
    );
    expect(result).toEqual({
      refreshed: [{ model: 'vendor/selected', variant: null }],
      unavailable: [{ model: 'vendor/removed', variant: null }],
      skipped: [],
    });
    expect(
      sqlite
        .prepare(`SELECT model, engine_identity, status, invalidated_at
      FROM benchmark_profiles ORDER BY model, engine_identity`)
        .all()
    ).toEqual([
      {
        model: 'vendor/other',
        engine_identity: 'test-engine',
        status: 'ready',
        invalidated_at: null,
      },
      {
        model: 'vendor/removed',
        engine_identity: 'test-engine',
        status: 'failed',
        invalidated_at: refreshedAt,
      },
      {
        model: 'vendor/selected',
        engine_identity: 'older-engine',
        status: 'ready',
        invalidated_at: null,
      },
      {
        model: 'vendor/selected',
        engine_identity: 'test-engine',
        status: 'pending',
        invalidated_at: refreshedAt,
      },
    ]);
  });

  it('repairs unavailable-model measurements without resetting valid profiles', async () => {
    seedProfile('vendor/selected');
    seedProfile('vendor/other');
    seedCase('vendor/selected', 'Error: Model not found: kilo/vendor/selected.');
    seedCase('vendor/other');
    const result = await refreshCurrentProfiles(
      db,
      {
        ...current,
        mode: 'repair_unavailable',
        entries: [
          { model: 'vendor/selected', variant: null },
          { model: 'vendor/other', variant: null },
        ],
      },
      catalog,
      refreshedAt
    );
    expect(result.refreshed).toEqual([{ model: 'vendor/selected', variant: null }]);
    expect(result.skipped).toEqual([{ model: 'vendor/other', variant: null }]);
    expect(
      sqlite.prepare(`SELECT status FROM benchmark_profiles WHERE model='vendor/other'`).get()
    ).toEqual({ status: 'ready' });
  });

  it('refuses a selection containing an active measurement without partial changes', async () => {
    seedProfile('vendor/selected');
    seedProfile('vendor/other', 'running');
    await expect(
      refreshCurrentProfiles(
        db,
        {
          ...current,
          mode: 'refresh',
          entries: [
            { model: 'vendor/selected', variant: null },
            { model: 'vendor/other', variant: null },
          ],
        },
        catalog,
        refreshedAt
      )
    ).rejects.toBeInstanceOf(ProfileRefreshConflictError);
    expect(
      sqlite
        .prepare(`SELECT status, invalidated_at FROM benchmark_profiles
      WHERE model='vendor/selected'`)
        .get()
    ).toEqual({ status: 'ready', invalidated_at: null });
  });

  it('refuses a failed entry while another case still holds its container slot', async () => {
    seedProfile('vendor/selected', 'failed');
    sqlite
      .prepare(`INSERT INTO scheduler_chunks (
      id,run_id,model,variant,providers,rep,chunk,case_ids,status,slot
    ) VALUES ('active-case','source','vendor/selected','','[]',0,0,'["case-a"]','active',0)`)
      .run();
    await expect(
      refreshCurrentProfiles(
        db,
        {
          ...current,
          mode: 'refresh',
          entries: [{ model: 'vendor/selected', variant: null }],
        },
        catalog,
        refreshedAt
      )
    ).rejects.toBeInstanceOf(ProfileRefreshConflictError);
    expect(sqlite.prepare(`SELECT status, invalidated_at FROM benchmark_profiles`).get()).toEqual({
      status: 'failed',
      invalidated_at: null,
    });
  });

  it('does not reset an entry claimed between the initial check and update', async () => {
    seedProfile('vendor/selected');
    let calls = 0;
    const racingDb = sqliteD1(sqlite, () => {
      calls += 1;
      if (calls === 2)
        sqlite
          .prepare(`UPDATE benchmark_profiles SET status='running'
        WHERE model='vendor/selected'`)
          .run();
    });
    await expect(
      refreshCurrentProfiles(
        racingDb,
        {
          ...current,
          mode: 'refresh',
          entries: [{ model: 'vendor/selected', variant: null }],
        },
        catalog,
        refreshedAt
      )
    ).rejects.toBeInstanceOf(ProfileRefreshConflictError);
    expect(sqlite.prepare(`SELECT status, invalidated_at FROM benchmark_profiles`).get()).toEqual({
      status: 'running',
      invalidated_at: null,
    });
  });

  it('preserves history but does not reuse invalidated results or pending output', async () => {
    seedProfile('vendor/selected');
    seedProfile('vendor/other');
    seedCase('vendor/selected');
    seedCase('vendor/other');
    sqlite
      .prepare(`INSERT INTO pending_decider_outputs
      (run_id,model,variant,case_id,rep,payload) VALUES ('source','vendor/selected','','case-b',0,?)`)
      .run(
        JSON.stringify({
          result: { exitCode: 0, timedOut: false, text: 'previous answer' },
          retried: false,
        })
      );
    await refreshCurrentProfiles(
      db,
      {
        ...current,
        mode: 'refresh',
        entries: [{ model: 'vendor/selected', variant: null }],
      },
      catalog,
      refreshedAt
    );
    seedRun('destination', '2026-01-03T00:00:00.000Z');
    await reuseDeciderCaseResults(db, {
      ...current,
      runId: 'destination',
      entries: [
        { model: 'vendor/selected', variant: null },
        { model: 'vendor/other', variant: null },
      ],
    });
    expect(
      sqlite.prepare(`SELECT model FROM case_results WHERE run_id='destination'`).all()
    ).toEqual([{ model: 'vendor/other' }]);
    expect(
      sqlite.prepare(`SELECT case_id FROM pending_decider_outputs WHERE run_id='destination'`).all()
    ).toEqual([]);
    expect(
      sqlite.prepare(`SELECT model FROM case_results WHERE run_id='source' ORDER BY model`).all()
    ).toEqual([{ model: 'vendor/other' }, { model: 'vendor/selected' }]);
    seedRun('new-source', '2026-01-03T00:00:00.000Z');
    sqlite
      .prepare(`INSERT INTO case_results (run_id,model,variant,case_id,score,latency_ms,exit_code,rep)
      VALUES ('new-source','vendor/selected','','case-a',1,10,0,0)`)
      .run();
    seedRun('later', '2026-01-04T00:00:00.000Z');
    expect(
      await reuseDeciderCaseResults(db, {
        ...current,
        runId: 'later',
        entries: [{ model: 'vendor/selected', variant: null }],
      })
    ).toBe(1);
  });
});
