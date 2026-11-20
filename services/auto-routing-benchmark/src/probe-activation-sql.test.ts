import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  copyRemeasureBaselines,
  listPendingCurrentProfiles,
  listQueuedRemeasures,
  markProfilesRunningForRun,
  reuseDeciderCaseResults,
} from './db';
import { DECIDER_CASES } from './datasets/decider-cases';
import {
  ACTIVE_MEASUREMENT_REVISION,
  deciderCasesForRouter,
  minimumCaseRevisions,
} from './measurement-revision';
import {
  PROBE_ACTIVATION_CASE_IDS,
  PROBE_ACTIVATION_ENGINE_IDENTITY,
  PROBE_ACTIVATION_PAIRS,
  PROBE_ACTIVATION_READMIT_PAIRS,
  PROBE_ACTIVATION_REMEASURE_PAIRS,
  PROBE_ACTIVATION_REPETITIONS,
  PROBE_ACTIVATION_REQUESTED_AT,
  PROBE_ACTIVATION_ROUTER,
  applyProbeActivations,
} from './probe-activation';
import { scheduleRunChunks } from './scheduler';

const MIGRATION = readFileSync(
  new URL('../migrations/0035_probe_activation.sql', import.meta.url),
  'utf8'
);
/** The `VALUES` rows the migration stages, as `action|model|variant|required_revision`. */
const stagedRows = [
  ...MIGRATION.replace(/\s+/g, ' ').matchAll(
    /\('efficient', '([a-z]+)', (\d+), '([^']+)', '([^']+)', 'efficient:v1:6649fed2', 3,/g
  ),
].map(match => `${match[1]}|${match[3]}|${match[4]}|${match[2]}`);
const pairKey = (model: string, variant: string) => `${model}|${variant}`;

const MODEL = 'anthropic/claude-haiku-5.5';
const VARIANT = 'low';
const OUTSIDE = { model: 'vendor/outside', variant: 'low' };
const PROBE_RUN_STARTED_AT = '2026-10-01T00:00:00.000Z';

describe('probe activation migration (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  function insertRun(id: string, { status = 'completed', startedAt = PROBE_RUN_STARTED_AT } = {}) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, measurement_revision)
         VALUES (?, 'efficient', 'decider', 'platform', ?, ?, 0.7, 3, 0, ?, ?, ?)`
      )
      .run(
        id,
        status,
        startedAt,
        PROBE_ACTIVATION_REPETITIONS,
        PROBE_ACTIVATION_ENGINE_IDENTITY,
        ACTIVE_MEASUREMENT_REVISION
      );
  }

  function insertChunk(runId: string, model: string, variant: string, status = 'queued') {
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids,
          status, lease_until)
         VALUES (?, ?, ?, ?, '[]', 0, 0, '["probe-cont-agent-tool-invoice-rollup-step-1"]', ?, 0)`
      )
      .run(`chunk-${runId}-${model}-${variant}-${status}`, runId, model, variant, status);
  }

  function insertResult(
    runId: string,
    model: string,
    variant: string,
    caseId: string,
    { rep = 0, revision = 2 } = {}
  ) {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
          cost_usd, rep, timed_out, exit_code, prompt_revision)
         VALUES (?, ?, ?, ?, 'implementation/code_generation', 0.5, 100, 0.001, ?, 0, 0, ?)`
      )
      .run(runId, model, variant, caseId, rep, revision);
  }

  function insertProfile(
    model: string,
    variant: string,
    {
      status = 'ready',
      runId = 'old',
      failureClass = null as string | null,
      repetitions = PROBE_ACTIVATION_REPETITIONS,
      engineIdentity = PROBE_ACTIVATION_ENGINE_IDENTITY,
      router = PROBE_ACTIVATION_ROUTER,
    }: {
      status?: string;
      runId?: string | null;
      failureClass?: string | null;
      repetitions?: number;
      engineIdentity?: string;
      router?: string;
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, failure_reason, failure_class, failure_attempts, model_failure_attempts,
          first_failed_at, retry_after, invalidated_at, requested_at, updated_at, completed_at,
          platform_requested, user_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL, '2026-10-01T00:00:00.000Z',
          '2026-10-01T00:00:00.000Z', ?, 1, 1)`
      )
      .run(
        router,
        model,
        variant,
        engineIdentity,
        repetitions,
        status,
        runId,
        status === 'failed' ? 'Benchmark lane did not finish' : null,
        failureClass,
        status === 'failed' ? '2026-11-11T10:34:45.042Z' : null,
        status === 'failed' ? '2026-11-11T11:42:25.620Z' : null,
        status === 'ready' ? '2026-10-01T00:00:00.000Z' : null
      );
  }

  /** A ready pair whose provenance run measured every decider case before revision 3. */
  function seedReadyPair(pair: { model: string; variant: string }, runId = 'old') {
    insertRun(runId);
    insertProfile(pair.model, pair.variant, { runId });
    for (const benchCase of DECIDER_CASES) {
      for (let rep = 0; rep < PROBE_ACTIVATION_REPETITIONS; rep++) {
        insertResult(runId, pair.model, pair.variant, benchCase.id, { rep });
      }
    }
  }

  /** The six Ember rows as production left them: failed, class `unknown`, retryable. */
  function seedFailedEmber() {
    insertRun('ember-failed', { status: 'failed' });
    for (const pair of PROBE_ACTIVATION_READMIT_PAIRS) {
      insertProfile(pair.model, pair.variant, {
        status: 'failed',
        runId: 'ember-failed',
        failureClass: 'unknown',
      });
    }
  }

  const current = {
    router: PROBE_ACTIVATION_ROUTER,
    engineIdentity: PROBE_ACTIVATION_ENGINE_IDENTITY,
    repetitions: PROBE_ACTIVATION_REPETITIONS,
  };

  const queuedPairs = () =>
    sqlite
      .prepare(
        'SELECT model, variant, run_id, requested_at FROM profile_remeasures ORDER BY model, variant'
      )
      .all();

  const profileRow = (model: string, variant: string) =>
    sqlite
      .prepare('SELECT * FROM benchmark_profiles WHERE model = ? AND variant = ?')
      .get(model, variant);

  it('mirrors the pair list and actions the code names', () => {
    expect(PROBE_ACTIVATION_PAIRS).toHaveLength(30);
    expect(PROBE_ACTIVATION_CASE_IDS).toHaveLength(22);
    expect(new Set(PROBE_ACTIVATION_PAIRS.map(p => pairKey(p.model, p.variant))).size).toBe(30);
    expect(stagedRows).toEqual([
      ...PROBE_ACTIVATION_REMEASURE_PAIRS.map(p => `remeasure|${pairKey(p.model, p.variant)}|3`),
      ...PROBE_ACTIVATION_READMIT_PAIRS.map(p => `readmit|${pairKey(p.model, p.variant)}|3`),
    ]);
    expect(MIGRATION).toContain(`'${PROBE_ACTIVATION_ENGINE_IDENTITY}'`);
    expect(MIGRATION).toContain(`'${PROBE_ACTIVATION_REQUESTED_AT}'`);
  });

  it('stages nothing the live worker can claim, then applies it once', async () => {
    for (const pair of PROBE_ACTIVATION_REMEASURE_PAIRS) seedReadyPair(pair);
    seedFailedEmber();

    // The migration only stages rows in `probe_activations`. The worker serving during the
    // drain-to-deploy window claims `profile_remeasures` rows and `pending` profiles
    // directly (`src/run.ts` drainQueue -> startRun -> markProfilesRunningForRun, and its
    // read sides listQueuedRemeasures / listPendingCurrentProfiles — none of them changed
    // from origin/main), so nothing it reads exists yet.
    expect(queuedPairs()).toEqual([]);
    expect(await listQueuedRemeasures(db, current, 'platform')).toEqual([]);
    expect(await listPendingCurrentProfiles(db, current, 'platform')).toEqual([]);
    expect(
      await markProfilesRunningForRun(db, 'live-worker-run', PROBE_ACTIVATION_PAIRS, current)
    ).toEqual([]);
    expect(profileRow('meta/muse-ember', 'low')).toMatchObject({
      status: 'failed',
      failure_class: 'unknown',
      run_id: 'ember-failed',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM probe_activations').get()).toEqual({ n: 30 });

    expect(await applyProbeActivations(db)).toEqual({ queued: 24, readmitted: 6 });

    expect(queuedPairs()).toEqual(
      PROBE_ACTIVATION_REMEASURE_PAIRS.map(pair => ({
        model: pair.model,
        variant: pair.variant,
        run_id: null,
        requested_at: PROBE_ACTIVATION_REQUESTED_AT,
      }))
    );
    for (const pair of PROBE_ACTIVATION_READMIT_PAIRS) {
      expect(profileRow(pair.model, pair.variant)).toMatchObject({
        status: 'pending',
        run_id: null,
        failure_reason: null,
        failure_class: null,
        failure_attempts: 0,
        model_failure_attempts: 0,
        first_failed_at: null,
        retry_after: null,
        invalidated_at: PROBE_ACTIVATION_REQUESTED_AT,
        requested_at: PROBE_ACTIVATION_REQUESTED_AT,
        updated_at: PROBE_ACTIVATION_REQUESTED_AT,
        completed_at: null,
      });
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM probe_activations').get()).toEqual({ n: 0 });
    expect(await applyProbeActivations(db)).toEqual({ queued: 0, readmitted: 0 });
    expect(queuedPairs()).toHaveLength(24);
  });

  it('waits for the deploy holding the dispatch lock before it applies anything', async () => {
    for (const pair of PROBE_ACTIVATION_REMEASURE_PAIRS) seedReadyPair(pair);
    seedFailedEmber();
    const deployLease = Date.parse('2026-11-20T00:00:00.000Z') + 120_000;
    sqlite
      .prepare(
        `INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until`
      )
      .run('deploy', deployLease);

    expect(await applyProbeActivations(db, PROBE_ACTIVATION_ROUTER, deployLease - 1)).toEqual({
      queued: 0,
      readmitted: 0,
    });
    expect(queuedPairs()).toEqual([]);
    expect(profileRow('meta/muse-ember', 'low')).toMatchObject({ status: 'failed' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM probe_activations').get()).toEqual({ n: 30 });

    expect(await applyProbeActivations(db, PROBE_ACTIVATION_ROUTER, deployLease + 1)).toEqual({
      queued: 24,
      readmitted: 6,
    });
  });

  it('applies a staged row only once the active revision reaches its required revision', async () => {
    for (const pair of PROBE_ACTIVATION_REMEASURE_PAIRS) seedReadyPair(pair);
    seedFailedEmber();
    // A row staged for a later revision must stay staged, and the apply must not delete it.
    seedReadyPair(OUTSIDE);
    sqlite
      .prepare(
        `INSERT INTO probe_activations (router, action, required_revision, model, variant,
          engine_identity, repetitions, requested_at)
         VALUES (?, 'remeasure', 4, ?, ?, ?, ?, ?)`
      )
      .run(
        PROBE_ACTIVATION_ROUTER,
        OUTSIDE.model,
        OUTSIDE.variant,
        PROBE_ACTIVATION_ENGINE_IDENTITY,
        PROBE_ACTIVATION_REPETITIONS,
        PROBE_ACTIVATION_REQUESTED_AT
      );
    const stagedRowsNow = sqlite.prepare(
      'SELECT action, model, variant, required_revision FROM probe_activations'
    );
    const at = Date.parse('2026-11-20T01:00:00.000Z');

    // Revision 2 is the rollback: nothing moves, nothing is consumed.
    expect(await applyProbeActivations(db, PROBE_ACTIVATION_ROUTER, at, 2)).toEqual({
      queued: 0,
      readmitted: 0,
    });
    expect(queuedPairs()).toEqual([]);
    expect(profileRow('meta/muse-ember', 'low')).toMatchObject({
      status: 'failed',
      failure_class: 'unknown',
    });
    expect(stagedRowsNow.all()).toHaveLength(31);

    // Revision 3 applies the 30 rows the migration stages and leaves the revision-4 row.
    expect(await applyProbeActivations(db, PROBE_ACTIVATION_ROUTER, at, 3)).toEqual({
      queued: 24,
      readmitted: 6,
    });
    expect(stagedRowsNow.all()).toEqual([
      {
        action: 'remeasure',
        model: OUTSIDE.model,
        variant: OUTSIDE.variant,
        required_revision: 4,
      },
    ]);
    expect(queuedPairs()).toHaveLength(24);
    expect(queuedPairs().map(row => pairKey(String(row.model), String(row.variant)))).not.toContain(
      pairKey(OUTSIDE.model, OUTSIDE.variant)
    );
    // Nothing runs twice: the revision-3 rows are gone and the revision-4 row still does not apply.
    expect(await applyProbeActivations(db, PROBE_ACTIVATION_ROUTER, at, 3)).toEqual({
      queued: 0,
      readmitted: 0,
    });
  });

  it('re-admit matches the per-row Re-admit and so does not reuse invalidated results', async () => {
    const pair = PROBE_ACTIVATION_READMIT_PAIRS[0];
    insertRun('ember-failed', { status: 'failed' });
    for (const benchCase of DECIDER_CASES) {
      for (let rep = 0; rep < PROBE_ACTIVATION_REPETITIONS; rep++) {
        insertResult('ember-failed', pair.model, pair.variant, benchCase.id, { rep });
      }
    }
    insertProfile(pair.model, pair.variant, {
      status: 'failed',
      runId: 'ember-failed',
      failureClass: 'unknown',
    });
    await applyProbeActivations(db);

    insertRun('ember-new', { status: 'running', startedAt: PROBE_ACTIVATION_REQUESTED_AT });
    const claimed = await markProfilesRunningForRun(db, 'ember-new', [pair], current);
    expect(claimed).toEqual([pair]);
    const minimumRevisions = minimumCaseRevisions(
      PROBE_ACTIVATION_ROUTER,
      ACTIVE_MEASUREMENT_REVISION
    );
    expect(await copyRemeasureBaselines(db, { runId: 'ember-new', minimumRevisions })).toBe(0);
    expect(
      await reuseDeciderCaseResults(db, {
        runId: 'ember-new',
        router: PROBE_ACTIVATION_ROUTER,
        engineIdentity: PROBE_ACTIVATION_ENGINE_IDENTITY,
        repetitions: PROBE_ACTIVATION_REPETITIONS,
        entries: [pair],
        minimumRevisions,
      })
    ).toBe(0);
    // The whole case list runs: the re-admit invalidated the failed run's rows, which is
    // what `src/profile-refresh.ts` does, and what the Ember forecast prices.
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM case_results WHERE run_id = ?').get('ember-new')
    ).toEqual({ n: 0 });
  });

  it('does not re-admit a row that is not a retryable failure, or that has a live chunk', async () => {
    const [permanent, otherClass, sameIdentity, otherIdentity, live] =
      PROBE_ACTIVATION_READMIT_PAIRS;
    // Permanent failure: same class, but the row is `unavailable`.
    insertProfile(permanent.model, permanent.variant, {
      status: 'unavailable',
      runId: 'permanent',
      failureClass: 'unknown',
    });
    // Retryable failure, but the class says the model is the cause.
    insertProfile(otherClass.model, otherClass.variant, {
      status: 'failed',
      runId: 'other-class',
      failureClass: 'grader',
    });
    // Three identical retryable failures; one has a live chunk under this identity, one
    // has a live chunk from another identity, one has none.
    for (const pair of [sameIdentity, otherIdentity, live]) {
      insertProfile(pair.model, pair.variant, {
        status: 'failed',
        runId: 'lane',
        failureClass: 'unknown',
      });
    }
    insertRun('lane', { status: 'running' });
    insertChunk('lane', live.model, live.variant);
    // A live chunk of another identity is not this pair's measurement.
    insertRun('other-engine', { status: 'failed' });
    sqlite
      .prepare(
        `UPDATE benchmark_runs SET engine_identity = 'efficient:v0:legacy' WHERE id = 'other-engine'`
      )
      .run();
    insertChunk('other-engine', otherIdentity.model, otherIdentity.variant);

    await applyProbeActivations(db);

    expect(profileRow(permanent.model, permanent.variant)).toMatchObject({
      status: 'unavailable',
      invalidated_at: null,
    });
    expect(profileRow(otherClass.model, otherClass.variant)).toMatchObject({
      status: 'failed',
      failure_class: 'grader',
      invalidated_at: null,
    });
    expect(profileRow(sameIdentity.model, sameIdentity.variant)).toMatchObject({
      status: 'pending',
    });
    expect(profileRow(live.model, live.variant)).toMatchObject({
      status: 'failed',
      invalidated_at: null,
    });
    expect(profileRow(otherIdentity.model, otherIdentity.variant)).toMatchObject({
      status: 'pending',
    });
  });

  it('queues no pair that is not ready, and none already measured at revision 3', async () => {
    const [measured, pending, notReady] = PROBE_ACTIVATION_REMEASURE_PAIRS;
    seedReadyPair(measured);
    seedReadyPair(pending);
    seedReadyPair(notReady);
    sqlite
      .prepare(`UPDATE benchmark_profiles SET status = 'running' WHERE model = ? AND variant = ?`)
      .run(notReady.model, notReady.variant);
    for (const caseId of PROBE_ACTIVATION_CASE_IDS) {
      insertResult('old', measured.model, measured.variant, caseId, { revision: 3 });
    }
    seedReadyPair(OUTSIDE);
    seedFailedEmber();

    const report = await applyProbeActivations(db);

    expect(queuedPairs()).toEqual([
      {
        model: pending.model,
        variant: pending.variant,
        run_id: null,
        requested_at: PROBE_ACTIVATION_REQUESTED_AT,
      },
    ]);
    expect(report).toEqual({ queued: 1, readmitted: 6 });
  });

  it('leaves a revision-2 probe result queued, since the case wants revision 3', async () => {
    const [pair] = PROBE_ACTIVATION_REMEASURE_PAIRS;
    seedReadyPair(pair);
    for (const caseId of PROBE_ACTIVATION_CASE_IDS) {
      insertResult('old', pair.model, pair.variant, caseId, { revision: 2 });
    }

    await applyProbeActivations(db);

    expect(queuedPairs()).toHaveLength(1);
  });

  it('schedules exactly the probe and pwd cases for a queued pair', async () => {
    const pair = { model: MODEL, variant: VARIANT };
    seedReadyPair(pair);
    await applyProbeActivations(db);

    const runId = 'remeasure';
    insertRun(runId, { status: 'running' });
    const claimed = await markProfilesRunningForRun(
      db,
      runId,
      [pair],
      current,
      PROBE_ACTIVATION_REQUESTED_AT
    );
    expect(claimed).toEqual([pair]);
    const minimumRevisions = minimumCaseRevisions(
      PROBE_ACTIVATION_ROUTER,
      ACTIVE_MEASUREMENT_REVISION
    );
    // Every decider case is reused except `supp-agent-term-pwd-base`, whose grading changed.
    expect(await copyRemeasureBaselines(db, { runId, minimumRevisions })).toBe(
      (DECIDER_CASES.length - 1) * PROBE_ACTIVATION_REPETITIONS
    );
    await reuseDeciderCaseResults(db, {
      runId,
      router: PROBE_ACTIVATION_ROUTER,
      engineIdentity: PROBE_ACTIVATION_ENGINE_IDENTITY,
      repetitions: PROBE_ACTIVATION_REPETITIONS,
      entries: [pair],
      minimumRevisions,
    });
    const caseIds = deciderCasesForRouter(PROBE_ACTIVATION_ROUTER, ACTIVE_MEASUREMENT_REVISION).map(
      benchCase => benchCase.id
    );
    await scheduleRunChunks(db, {
      runId,
      entries: [pair],
      repetitions: PROBE_ACTIVATION_REPETITIONS,
      caseIds,
      chunkSize: 1,
    });

    const reused = sqlite
      .prepare('SELECT COUNT(*) AS n FROM case_results WHERE run_id = ?')
      .get(runId);
    expect(reused).toEqual({ n: (DECIDER_CASES.length - 1) * PROBE_ACTIVATION_REPETITIONS });

    const pending = sqlite
      .prepare(`SELECT case_ids, rep FROM scheduler_chunks WHERE run_id = ? AND status = 'pending'`)
      .all(runId)
      .flatMap(row =>
        (JSON.parse(String(row.case_ids)) as string[]).map(caseId => ({
          case_id: caseId,
          rep: Number(row.rep),
        }))
      )
      .sort((a, b) => (a.case_id === b.case_id ? a.rep - b.rep : a.case_id < b.case_id ? -1 : 1));
    const expected = PROBE_ACTIVATION_CASE_IDS.flatMap(caseId =>
      Array.from({ length: PROBE_ACTIVATION_REPETITIONS }, (_, rep) => ({ case_id: caseId, rep }))
    ).sort((a, b) => (a.case_id === b.case_id ? a.rep - b.rep : a.case_id < b.case_id ? -1 : 1));
    expect(pending).toEqual(expected);
  });
});
