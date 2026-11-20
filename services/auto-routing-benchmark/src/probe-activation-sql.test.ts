import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { copyRemeasureBaselines, markProfilesRunningForRun, reuseDeciderCaseResults } from './db';
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
} from './probe-activation';
import { scheduleRunChunks } from './scheduler';

const MIGRATION = readFileSync(
  new URL('../migrations/0035_probe_activation.sql', import.meta.url),
  'utf8'
);
const ACTIVATION_STATEMENTS = MIGRATION.split('--> statement-breakpoint');

/** The pieces of the migration that name which rows it touches. */
const remeasureSection = section('`remeasure`(`model`, `variant`) AS (', '`probe_cases`');
const caseSection = section('`probe_cases`(`case_id`) AS (', 'INSERT INTO');
const readmitSection = section('UPDATE `benchmark_profiles` SET', ');');
const readmitVariantsSection = section('AND `variant` IN (', ')');

function section(start: string, end: string): string {
  const from = MIGRATION.indexOf(start);
  const to = MIGRATION.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`migration lacks the ${start} section`);
  return MIGRATION.slice(from + start.length, to);
}

const pairKey = (model: string, variant: string) => `${model}|${variant}`;
const sqlPairs = [...remeasureSection.matchAll(/\('([^']+)', '([^']+)'\)/g)].map(match =>
  pairKey(match[1], match[2])
);

function applyActivation(sqlite: DatabaseSync): void {
  for (const statement of ACTIVATION_STATEMENTS) {
    if (statement.trim() === '') continue;
    sqlite.exec(statement);
  }
}

const MODEL = 'anthropic/claude-haiku-5.5';
const VARIANT = 'low';
const OUTSIDE = { model: 'vendor/outside', variant: 'low' };

describe('probe activation migration (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  function insertRun(id: string, status = 'completed') {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, measurement_revision)
         VALUES (?, 'efficient', 'decider', 'platform', ?, '2026-10-01T00:00:00.000Z',
          0.7, 3, 0, ?, ?, ?)`
      )
      .run(
        id,
        status,
        PROBE_ACTIVATION_REPETITIONS,
        PROBE_ACTIVATION_ENGINE_IDENTITY,
        ACTIVE_MEASUREMENT_REVISION
      );
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
    }: { status?: string; runId?: string | null; failureClass?: string | null } = {}
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
        PROBE_ACTIVATION_ROUTER,
        model,
        variant,
        PROBE_ACTIVATION_ENGINE_IDENTITY,
        PROBE_ACTIVATION_REPETITIONS,
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

  it('mirrors the pair and case lists the code names', () => {
    expect(PROBE_ACTIVATION_PAIRS).toHaveLength(29);
    expect(PROBE_ACTIVATION_CASE_IDS).toHaveLength(22);
    expect(new Set(PROBE_ACTIVATION_PAIRS.map(p => pairKey(p.model, p.variant))).size).toBe(29);
    expect(sqlPairs).toEqual(
      PROBE_ACTIVATION_REMEASURE_PAIRS.map(p => pairKey(p.model, p.variant))
    );
    const sqlCaseIds = [...caseSection.matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1]);
    expect(sqlCaseIds).toEqual([...PROBE_ACTIVATION_CASE_IDS]);
    const readmitVariants = [...readmitVariantsSection.matchAll(/'([a-z]+)'/g)].map(
      match => match[1]
    );
    expect(readmitVariants).toEqual(PROBE_ACTIVATION_READMIT_PAIRS.map(p => p.variant));
    expect(readmitSection).toContain(`'meta/muse-ember'`);
    expect(readmitSection).toContain(`AND \`status\` = 'failed'`);
    expect(MIGRATION).toContain(`'${PROBE_ACTIVATION_ENGINE_IDENTITY}'`);
    expect(MIGRATION).toContain(`'${PROBE_ACTIVATION_REQUESTED_AT}'`);
  });

  it('queues the 23 ready pairs and re-admits the six Ember rows, and nothing else', () => {
    for (const pair of PROBE_ACTIVATION_REMEASURE_PAIRS) seedReadyPair(pair);
    for (const pair of PROBE_ACTIVATION_READMIT_PAIRS) {
      insertProfile(pair.model, pair.variant, {
        status: 'failed',
        runId: 'ember-failed',
        failureClass: 'unknown',
      });
    }
    seedReadyPair(OUTSIDE);
    insertProfile('vendor/broken', 'low', {
      status: 'failed',
      runId: 'broken-failed',
      failureClass: 'unknown',
    });

    applyActivation(sqlite);

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
    expect(profileRow(OUTSIDE.model, OUTSIDE.variant)).toMatchObject({
      status: 'ready',
      run_id: 'old',
    });
    expect(profileRow('vendor/broken', 'low')).toMatchObject({
      status: 'failed',
      failure_class: 'unknown',
    });
  });

  it('is a no-op on a second run', () => {
    for (const pair of PROBE_ACTIVATION_REMEASURE_PAIRS) seedReadyPair(pair);
    for (const pair of PROBE_ACTIVATION_READMIT_PAIRS) {
      insertProfile(pair.model, pair.variant, {
        status: 'failed',
        runId: 'ember-failed',
        failureClass: 'unknown',
      });
    }
    applyActivation(sqlite);
    const first = queuedPairs();
    const emberAfterFirst = profileRow('meta/muse-ember', 'low');

    applyActivation(sqlite);

    expect(queuedPairs()).toEqual(first);
    expect(profileRow('meta/muse-ember', 'low')).toEqual(emberAfterFirst);
  });

  it('does not queue a pair whose provenance run already measured the probes at revision 3', () => {
    const [measured, pending] = PROBE_ACTIVATION_REMEASURE_PAIRS;
    seedReadyPair(measured);
    seedReadyPair(pending);
    for (const caseId of PROBE_ACTIVATION_CASE_IDS) {
      insertResult('old', measured.model, measured.variant, caseId, { revision: 3 });
    }

    applyActivation(sqlite);

    expect(queuedPairs()).toEqual([
      {
        model: pending.model,
        variant: pending.variant,
        run_id: null,
        requested_at: PROBE_ACTIVATION_REQUESTED_AT,
      },
    ]);
  });

  it('leaves a revision-2 probe result queued, since the case wants revision 3', () => {
    const [pair] = PROBE_ACTIVATION_REMEASURE_PAIRS;
    seedReadyPair(pair);
    for (const caseId of PROBE_ACTIVATION_CASE_IDS) {
      insertResult('old', pair.model, pair.variant, caseId, { revision: 2 });
    }

    applyActivation(sqlite);

    expect(queuedPairs()).toHaveLength(1);
  });

  it('schedules exactly the probe and pwd cases for a queued pair', async () => {
    const pair = { model: MODEL, variant: VARIANT };
    seedReadyPair(pair);
    applyActivation(sqlite);

    const runId = 'remeasure';
    insertRun(runId, 'running');
    const claimed = await markProfilesRunningForRun(
      db,
      runId,
      [pair],
      {
        router: PROBE_ACTIVATION_ROUTER,
        engineIdentity: PROBE_ACTIVATION_ENGINE_IDENTITY,
        repetitions: PROBE_ACTIVATION_REPETITIONS,
      },
      '2026-11-20T00:00:00.000Z'
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
