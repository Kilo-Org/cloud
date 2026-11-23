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

function seedCase(
  model: string,
  error: string | null = null,
  measured: { costUsd?: number | null; outputPrefix?: string | null; timedOut?: boolean } = {}
) {
  sqlite
    .prepare(`INSERT INTO case_results (
    run_id, model, variant, case_id, score, latency_ms, exit_code, error, rep,
    cost_usd, output_prefix, timed_out
  ) VALUES ('source', ?, '', 'case-a', 1, 10, ?, ?, 0, ?, ?, ?)`)
    .run(
      model,
      error ? 1 : 0,
      error,
      measured.costUsd ?? null,
      measured.outputPrefix ?? null,
      measured.timedOut ? 1 : 0
    );
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  db = sqliteD1(sqlite);
  seedRun('source');
});
afterEach(() => sqlite.close());

describe('targeted benchmark refresh', () => {
  it('invalidates only selected current pairs and fails unavailable models permanently', async () => {
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
      refusals: [
        {
          entry: { model: 'vendor/removed', variant: null },
          failureClass: 'catalog_absent',
          reason: 'Model or variant is unavailable in the executable benchmark catalog.',
        },
      ],
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
        status: 'unavailable',
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

  it.each([
    'Error: Model not found: kilo/vendor/selected.',
    'Error: Model not found: vendor/selected. Did you mean: vendor/other?',
    '\u001b[31mError:\u001b[0m Model not found: kilo/vendor/selected',
  ])(
    'repairs exact unavailable-model measurements without resetting valid profiles: %s',
    async error => {
      seedProfile('vendor/selected');
      seedProfile('vendor/other');
      seedCase('vendor/selected', error);
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
    }
  );

  it.each([
    {
      error:
        'Model not found: kilo/vendor/selected. Failed to load the Kilo model catalog (network). Check your connection and credentials.',
    },
    { error: 'Model not found: kilo/vendor/selected-other' },
    { error: 'Model not found: kilo/vendor/other' },
    { error: 'Model not found: kilo/vendor/selected', costUsd: 0.01 },
    { error: 'Model not found: kilo/vendor/selected', timedOut: true },
    { error: 'Model not found: kilo/vendor/selected', outputPrefix: 'measured answer' },
    { error: 'Provider API failed: resource not found' },
  ])(
    'does not repair catalog failures or unrelated measurements: %j',
    async ({ error, ...measured }) => {
      seedProfile('vendor/selected');
      seedCase('vendor/selected', error, measured);
      const result = await refreshCurrentProfiles(
        db,
        {
          ...current,
          mode: 'repair_unavailable',
          entries: [{ model: 'vendor/selected', variant: null }],
        },
        catalog,
        refreshedAt
      );
      expect(result).toEqual({
        refreshed: [],
        unavailable: [],
        skipped: [{ model: 'vendor/selected', variant: null }],
        refusals: [],
      });
      expect(
        sqlite.prepare(`SELECT status, run_id, invalidated_at FROM benchmark_profiles`).get()
      ).toEqual({ status: 'ready', run_id: 'source', invalidated_at: null });
    }
  );

  it('does not repair a profile whose measurement changed after reading lookup failures', async () => {
    seedProfile('vendor/selected');
    seedCase('vendor/selected', 'Model not found: kilo/vendor/selected');
    seedRun('replacement');
    let calls = 0;
    const racingDb = sqliteD1(sqlite, () => {
      calls += 1;
      if (calls === 3)
        sqlite
          .prepare(`UPDATE benchmark_profiles SET run_id='replacement'
        WHERE model='vendor/selected'`)
          .run();
    });
    const result = await refreshCurrentProfiles(
      racingDb,
      {
        ...current,
        mode: 'repair_unavailable',
        entries: [{ model: 'vendor/selected', variant: null }],
      },
      catalog,
      refreshedAt
    );
    expect(result.skipped).toEqual([{ model: 'vendor/selected', variant: null }]);
    expect(
      sqlite.prepare(`SELECT status, run_id, invalidated_at FROM benchmark_profiles`).get()
    ).toEqual({ status: 'ready', run_id: 'replacement', invalidated_at: null });
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

  it('re-admits a permanent failure without invalidating or discarding compatible results', async () => {
    seedProfile('vendor/selected');
    seedCase('vendor/selected');
    // An older stamp (before the measured run) marks a compatible result set; re-admission
    // must keep it, so the past case stays reusable.
    const olderInvalidation = '2025-12-31T00:00:00.000Z';
    sqlite
      .prepare(
        `UPDATE benchmark_profiles SET status = 'unavailable', failure_class = 'provider_unavailable',
          failure_attempts = 6, first_failed_at = ?, completed_at = ?, invalidated_at = ?
         WHERE model = 'vendor/selected'`
      )
      .run(measuredAt, measuredAt, olderInvalidation);
    const result = await refreshCurrentProfiles(
      db,
      { ...current, mode: 'refresh', entries: [{ model: 'vendor/selected', variant: null }] },
      catalog,
      refreshedAt
    );
    expect(result.refreshed).toEqual([{ model: 'vendor/selected', variant: null }]);
    expect(
      sqlite
        .prepare(
          `SELECT status, failure_attempts, first_failed_at, requested_at, invalidated_at
           FROM benchmark_profiles WHERE model = 'vendor/selected'`
        )
        .get()
    ).toEqual({
      status: 'pending',
      failure_attempts: 0,
      first_failed_at: null,
      requested_at: refreshedAt,
      invalidated_at: olderInvalidation,
    });
    // The reset marker commits with the re-admission and does not depend on invalidation.
    expect(
      sqlite
        .prepare(
          `SELECT outcome, run_id, attempted_at FROM profile_attempt_history WHERE model = ?`
        )
        .all('vendor/selected')
    ).toEqual([
      {
        outcome: 'reset',
        run_id: `admit:${refreshedAt}:vendor/selected:`,
        attempted_at: refreshedAt,
      },
    ]);
    seedRun('later', '2026-01-04T00:00:00.000Z');
    expect(
      await reuseDeciderCaseResults(db, {
        ...current,
        runId: 'later',
        entries: [{ model: 'vendor/selected', variant: null }],
        minimumRevisions: {},
      })
    ).toBe(1);
  });

  it('clears a permanent verdict at another repetition count of this engine on re-admit', async () => {
    seedProfile('vendor/selected');
    // A previous config measured this pair at another repetition count and marked it
    // permanently unavailable. Current config selects repetitions=1, so that row is not
    // current and cannot veto today's plan — but it must not return as a veto if the
    // repetition count changes back after an explicit re-admission.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, failure_class, failure_attempts, requested_at, updated_at, platform_requested,
          user_requested)
         VALUES ('efficient', 'vendor/selected', '', ?, 3, 'unavailable', 'provider_unavailable',
          6, ?, ?, 0, 1)`
      )
      .run(current.engineIdentity, measuredAt, measuredAt);
    await refreshCurrentProfiles(
      db,
      { ...current, mode: 'refresh', entries: [{ model: 'vendor/selected', variant: null }] },
      catalog,
      refreshedAt
    );
    expect(
      sqlite
        .prepare(
          `SELECT repetitions, status, failure_attempts, first_failed_at
           FROM benchmark_profiles WHERE model = 'vendor/selected' ORDER BY repetitions`
        )
        .all()
    ).toEqual([
      {
        repetitions: 1,
        status: 'pending',
        failure_attempts: 0,
        first_failed_at: null,
      },
      {
        repetitions: 3,
        status: 'pending',
        failure_attempts: 0,
        first_failed_at: null,
      },
    ]);
  });

  it('leaves another router and another engine alone when re-admitting', async () => {
    seedProfile('vendor/selected');
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, requested_at, updated_at, platform_requested, user_requested)
         VALUES ('frontier', 'vendor/selected', '', ?, 1, 'unavailable', ?, ?, 0, 1),
                ('efficient', 'vendor/selected', '', 'engine-old', 1, 'unavailable', ?, ?, 0, 1)`
      )
      .run(current.engineIdentity, measuredAt, measuredAt, measuredAt, measuredAt);
    await refreshCurrentProfiles(
      db,
      { ...current, mode: 'refresh', entries: [{ model: 'vendor/selected', variant: null }] },
      catalog,
      refreshedAt
    );
    expect(
      sqlite
        .prepare(
          `SELECT router, engine_identity, status FROM benchmark_profiles
           WHERE model = 'vendor/selected' ORDER BY router, engine_identity`
        )
        .all()
    ).toEqual([
      { router: 'efficient', engine_identity: 'engine-old', status: 'unavailable' },
      { router: 'efficient', engine_identity: current.engineIdentity, status: 'pending' },
      { router: 'frontier', engine_identity: current.engineIdentity, status: 'unavailable' },
    ]);
  });

  it('repair_unavailable preserves invalidation so the repaired pair keeps its past results', async () => {
    seedProfile('vendor/selected');
    // The repair selector needs the recorded lookup failure; the compatible result that
    // must stay reusable is a separate, valid case of the same pair.
    seedCase('vendor/selected', 'Model not found: kilo/vendor/selected');
    sqlite
      .prepare(`INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms,
        exit_code, rep) VALUES ('source', 'vendor/selected', '', 'case-b', 1, 10, 0, 0)`)
      .run();
    const seededInvalidation = '2026-01-01T12:00:00.000Z';
    sqlite
      .prepare('UPDATE benchmark_profiles SET invalidated_at = ? WHERE model = ?')
      .run(seededInvalidation, 'vendor/selected');
    const result = await refreshCurrentProfiles(
      db,
      {
        ...current,
        mode: 'repair_unavailable',
        entries: [{ model: 'vendor/selected', variant: null }],
      },
      catalog,
      refreshedAt
    );
    expect(result.refreshed).toEqual([{ model: 'vendor/selected', variant: null }]);
    // The repair must neither introduce nor move an invalidation stamp.
    expect(
      sqlite
        .prepare(
          `SELECT status, invalidated_at, requested_at FROM benchmark_profiles
           WHERE model = 'vendor/selected'`
        )
        .get()
    ).toEqual({
      status: 'pending',
      invalidated_at: seededInvalidation,
      requested_at: refreshedAt,
    });
  });

  it('repair_unavailable on an uninvalidated pair keeps every compatible result reusable', async () => {
    seedProfile('vendor/selected');
    seedCase('vendor/selected', 'Model not found: kilo/vendor/selected');
    sqlite
      .prepare(`INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms,
        exit_code, rep) VALUES ('source', 'vendor/selected', '', 'case-b', 1, 10, 0, 0)`)
      .run();
    await refreshCurrentProfiles(
      db,
      {
        ...current,
        mode: 'repair_unavailable',
        entries: [{ model: 'vendor/selected', variant: null }],
      },
      catalog,
      refreshedAt
    );
    expect(
      sqlite
        .prepare(`SELECT status, invalidated_at FROM benchmark_profiles WHERE model = ?`)
        .get('vendor/selected')
    ).toEqual({ status: 'pending', invalidated_at: null });
    seedRun('later', '2026-01-04T00:00:00.000Z');
    expect(
      await reuseDeciderCaseResults(db, {
        ...current,
        runId: 'later',
        entries: [{ model: 'vendor/selected', variant: null }],
        minimumRevisions: {},
      })
    ).toBe(1);
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
      minimumRevisions: {},
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
        minimumRevisions: {},
      })
    ).toBe(1);
  });
});
