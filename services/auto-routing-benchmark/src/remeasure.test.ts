import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { deciderCliPrompt } from './cli-runner';
import { DECIDER_CASES, FRONTIER_CASES, type DeciderCase } from './datasets/decider-cases';
import {
  copyRemeasureBaselines,
  countCurrentProfilesByStatus,
  listQueuedRemeasures,
  listReadyCurrentProfilesForEntries,
  markProfilesFailedForRun,
  markProfilesRunningForRun,
  releaseProfileClaims,
  reuseDeciderCaseResults,
  settleRemeasuresForRun,
} from './db';
import {
  argvAffectedCases,
  PROMPT_TRANSPORT_REVISION,
  snapshotPromptTokens,
} from './prompt-transport';
import { planPromptTransportRemeasure } from './remeasure';
import { scheduleRunChunks } from './scheduler';

const ENGINE = 'efficient:v1:test';
const FRONTIER_ENGINE = 'frontier:v1:test';
const MODEL = 'vendor/model';
const current = { router: 'efficient' as const, engineIdentity: ENGINE, repetitions: 1 };
const entry = { model: MODEL, variant: null };

const quoted = (c: DeciderCase) => !c.longContext && deciderCliPrompt(c).includes('"');
function find(cases: readonly DeciderCase[], predicate: (c: DeciderCase) => boolean) {
  const found = cases.find(predicate);
  if (!found) throw new Error('dataset lacks a case for this test');
  return found;
}
const longCase = find(DECIDER_CASES, c => Boolean(c.longContext));
const quotedExact = find(
  DECIDER_CASES,
  c => quoted(c) && ['exact', 'contains_all', 'regex'].includes(c.check.kind)
);
const quotedStructured = find(
  DECIDER_CASES,
  c => quoted(c) && !['exact', 'contains_all', 'regex'].includes(c.check.kind)
);
const plainCases = DECIDER_CASES.filter(c => !c.longContext && !deciderCliPrompt(c).includes('"'));
const [plainCase, otherPlainCase] = plainCases;
const frontierLong = find(FRONTIER_CASES, c => Boolean(c.longContext));
const frontierQuoted = find(FRONTIER_CASES, quoted);
const affectedIds = (router: AutoRouter, frontierInnerQuotes = false) =>
  argvAffectedCases(router, { frontierInnerQuotes }).map(c => c.id);

describe('prompt transport re-measure (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  function insertRun(
    id: string,
    { status = 'completed', startedAt = '2026-10-01T00:00:00.000Z', router = 'efficient' } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity)
         VALUES (?, ?, 'decider', 'platform', ?, ?, 0.7, 3, 0, 1, ?)`
      )
      .run(id, router, status, startedAt, router === 'frontier' ? FRONTIER_ENGINE : ENGINE);
  }

  function insertResult(
    runId: string,
    caseId: string,
    {
      revision = 1,
      cost = 0.001 as number | null,
      error = null as string | null,
      exitCode = 0,
      model = MODEL,
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
          cost_usd, error, exit_code, rep, timed_out, prompt_revision)
         VALUES (?, ?, '', ?, 'implementation/code_generation', 0.5, 100, ?, ?, ?, 0, 0, ?)`
      )
      .run(runId, model, caseId, cost, error, exitCode, revision);
  }

  function insertPending(runId: string, caseId: string, revision: number) {
    const payload = {
      result: {
        text: 'ok',
        costUsd: 0.001,
        latencyMs: 10,
        exitCode: 0,
        stderrTail: '',
        eventCount: 1,
        lastEventTypes: ['text'],
        timedOut: false,
      },
      retried: false,
    };
    sqlite
      .prepare(
        `INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload,
          prompt_revision) VALUES (?, ?, '', ?, 0, ?, ?)`
      )
      .run(runId, MODEL, caseId, JSON.stringify(payload), revision);
  }

  function insertProfile(
    runId: string,
    { model = MODEL, platform = true, user = false, router = 'efficient' } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES (?, ?, '', ?, 1, 'ready', ?, '2026-10-01', '2026-10-01', '2026-10-01', ?, ?)`
      )
      .run(
        router,
        model,
        router === 'frontier' ? FRONTIER_ENGINE : ENGINE,
        runId,
        platform ? 1 : 0,
        user ? 1 : 0
      );
  }

  const caseIds = (runId: string) =>
    sqlite
      .prepare('SELECT case_id FROM case_results WHERE run_id = ? ORDER BY case_id')
      .all(runId)
      .map(row => String(row.case_id));
  const profileRunId = (model = MODEL) =>
    sqlite.prepare('SELECT run_id, status FROM benchmark_profiles WHERE model = ?').get(model);
  const tableDump = () =>
    ['benchmark_profiles', 'profile_remeasures', 'case_results', 'pending_decider_outputs'].map(
      table => sqlite.prepare(`SELECT * FROM ${table}`).all()
    );

  /** A ready platform pair measured entirely under the revision-1 transport. */
  function seedMeasuredPair(model = MODEL, options: { platform?: boolean; user?: boolean } = {}) {
    for (const benchCase of DECIDER_CASES) {
      insertResult(
        'old',
        benchCase.id,
        benchCase.id === plainCase?.id ? { model, error: 'provider down', exitCode: 1 } : { model }
      );
    }
    insertProfile('old', { model, ...options });
  }

  it('selects every long-context case and quote-echo efficient cases, with a frontier flag', () => {
    const efficient = affectedIds('efficient');
    expect(efficient).toContain(longCase.id);
    expect(efficient).toContain(quotedExact.id);
    expect(efficient).not.toContain(quotedStructured.id);
    expect(efficient).not.toContain(plainCase?.id);
    expect(efficient).toEqual(
      DECIDER_CASES.filter(
        c =>
          c.longContext || (quoted(c) && ['exact', 'contains_all', 'regex'].includes(c.check.kind))
      ).map(c => c.id)
    );

    expect(affectedIds('frontier')).toContain(frontierLong.id);
    expect(affectedIds('frontier')).not.toContain(frontierQuoted.id);
    expect(affectedIds('frontier', true)).toEqual(
      [
        ...new Set([...affectedIds('frontier'), ...FRONTIER_CASES.filter(quoted).map(c => c.id)]),
      ].sort(
        (a, b) =>
          FRONTIER_CASES.findIndex(c => c.id === a) - FRONTIER_CASES.findIndex(c => c.id === b)
      )
    );
  });

  it('reuses every prior result except affected cases from the old transport', async () => {
    if (!plainCase || !otherPlainCase) throw new Error('dataset needs plain cases');
    insertRun('old');
    insertResult('old', longCase.id);
    insertResult('old', quotedExact.id);
    insertResult('old', plainCase.id);
    insertResult('old', quotedStructured.id);
    insertRun('fixed', { startedAt: '2026-10-02T00:00:00.000Z' });
    insertResult('fixed', quotedExact.id, { revision: PROMPT_TRANSPORT_REVISION });
    insertRun('recovered', { startedAt: '2026-10-03T00:00:00.000Z' });
    insertPending('recovered', longCase.id, 1);
    insertPending('recovered', otherPlainCase.id, 1);
    insertRun('dest', { status: 'running', startedAt: '2026-10-04T00:00:00.000Z' });

    await reuseDeciderCaseResults(db, {
      runId: 'dest',
      ...current,
      entries: [entry],
      skipOldCaseIds: affectedIds('efficient'),
      promptRevision: PROMPT_TRANSPORT_REVISION,
    });

    expect(caseIds('dest')).toEqual([plainCase.id, quotedExact.id, quotedStructured.id].sort());
    expect(
      sqlite
        .prepare('SELECT prompt_revision FROM case_results WHERE run_id = ? AND case_id = ?')
        .get('dest', quotedExact.id)
    ).toEqual({ prompt_revision: PROMPT_TRANSPORT_REVISION });
    expect(
      sqlite
        .prepare("SELECT case_id FROM pending_decider_outputs WHERE run_id = 'dest'")
        .all()
        .map(row => row.case_id)
    ).toEqual([otherPlainCase.id]);
  });

  it('dry-runs a report with projected spend and writes nothing', async () => {
    insertRun('old');
    seedMeasuredPair();
    const before = tableDump();
    const report = await planPromptTransportRemeasure(db, {
      ...current,
      action: 'dry-run',
      prices: new Map([
        [
          MODEL,
          { promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6, cacheReadUsdPerToken: null },
        ],
      ]),
    });
    const affected = argvAffectedCases('efficient');
    const snapshotTokens = affected.reduce((total, c) => total + snapshotPromptTokens(c), 0);
    expect(report).toMatchObject({
      pairs: 1,
      affectedResults: affected.length,
      unknownCostResults: 0,
      changed: 0,
      pairDetails: [{ model: MODEL, queues: ['platform'], state: null }],
    });
    expect(report.projectedCostUsd).toBeCloseTo(affected.length * 0.001 + snapshotTokens * 1e-6, 9);
    expect(snapshotTokens).toBeGreaterThan(0);
    expect(tableDump()).toEqual(before);
  });

  it('re-measures only affected cases while the pair keeps serving its previous run', async () => {
    if (!plainCase) throw new Error('dataset needs a plain case');
    insertRun('old');
    seedMeasuredPair();
    const request = () =>
      planPromptTransportRemeasure(db, { ...current, action: 'request', prices: new Map() });
    expect((await request()).changed).toBe(1);
    expect((await request()).changed).toBe(0);
    expect(await listQueuedRemeasures(db, current, 'platform')).toHaveLength(1);
    expect(await listQueuedRemeasures(db, current, 'user')).toHaveLength(0);

    expect(await markProfilesRunningForRun(db, 'remeasure', [entry], current)).toEqual([entry]);
    expect(await markProfilesRunningForRun(db, 'other', [entry], current)).toEqual([]);
    expect(await listQueuedRemeasures(db, current, 'platform')).toHaveLength(0);

    // Status, owner-pool tables and platform publication still see the previous run.
    expect(profileRunId()).toEqual({ run_id: 'old', status: 'ready' });
    expect(await listReadyCurrentProfilesForEntries(db, current, [entry])).toEqual([
      { model: MODEL, variant: '', run_id: 'old' },
    ]);
    expect(await countCurrentProfilesByStatus(db, current, 'platform')).toEqual([
      { status: 'ready', count: 1 },
    ]);
    expect((await request()).pairDetails[0]).toMatchObject({
      state: 'running',
      runId: 'remeasure',
    });

    insertRun('remeasure', { status: 'running', startedAt: '2026-10-05T00:00:00.000Z' });
    const skipOldCaseIds = affectedIds('efficient');
    await copyRemeasureBaselines(db, {
      runId: 'remeasure',
      skipOldCaseIds,
      promptRevision: PROMPT_TRANSPORT_REVISION,
    });
    await reuseDeciderCaseResults(db, {
      runId: 'remeasure',
      ...current,
      entries: [entry],
      skipOldCaseIds,
      promptRevision: PROMPT_TRANSPORT_REVISION,
    });
    const unaffected = DECIDER_CASES.filter(c => !skipOldCaseIds.includes(c.id)).map(c => c.id);
    expect(caseIds('remeasure')).toEqual([...unaffected].sort());
    expect(
      sqlite
        .prepare('SELECT error FROM case_results WHERE run_id = ? AND case_id = ?')
        .get('remeasure', plainCase.id)
    ).toEqual({ error: 'provider down' });

    await scheduleRunChunks(db, {
      runId: 'remeasure',
      entries: [{ ...entry, providers: [] }],
      repetitions: 1,
      caseIds: DECIDER_CASES.map(c => c.id),
      chunkSize: 1,
    });
    const scheduled = sqlite
      .prepare("SELECT case_ids FROM scheduler_chunks WHERE run_id = ? AND status = 'pending'")
      .all('remeasure')
      .flatMap(row => JSON.parse(String(row.case_ids)) as string[]);
    expect(scheduled.sort()).toEqual([...skipOldCaseIds].sort());

    for (const caseId of skipOldCaseIds) {
      insertResult('remeasure', caseId, { revision: PROMPT_TRANSPORT_REVISION });
    }
    await settleRemeasuresForRun(db, 'remeasure', []);
    expect(profileRunId()).toEqual({ run_id: 'remeasure', status: 'ready' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_remeasures').get()).toEqual({ n: 0 });
    expect((await request()).pairs).toBe(0);
  });

  it('queues owner-only pairs for the owner queue', async () => {
    insertRun('old');
    seedMeasuredPair(MODEL, { platform: false, user: true });
    await planPromptTransportRemeasure(db, { ...current, action: 'request', prices: new Map() });
    expect(await listQueuedRemeasures(db, current, 'user')).toEqual([
      expect.objectContaining({ model: MODEL, variant: '' }),
    ]);
    expect(await listQueuedRemeasures(db, current, 'platform')).toEqual([]);
  });

  it('keeps the previous measurement when the re-measure fails', async () => {
    insertRun('old');
    seedMeasuredPair('vendor/dead');
    seedMeasuredPair('vendor/failed');
    seedMeasuredPair('vendor/released');
    await planPromptTransportRemeasure(db, { ...current, action: 'request', prices: new Map() });
    const pair = (model: string) => ({ model, variant: null });

    await markProfilesRunningForRun(db, 'dead-lane', [pair('vendor/dead')], current);
    await settleRemeasuresForRun(db, 'dead-lane', [{ model: 'vendor/dead', variant: '' }]);
    expect(profileRunId('vendor/dead')).toEqual({ run_id: 'old', status: 'ready' });

    await markProfilesRunningForRun(db, 'failed-run', [pair('vendor/failed')], current);
    await markProfilesFailedForRun(db, 'failed-run', 'scheduler initialization failed');
    expect(profileRunId('vendor/failed')).toEqual({ run_id: 'old', status: 'ready' });

    await markProfilesRunningForRun(db, 'unwritten', [pair('vendor/released')], current);
    await releaseProfileClaims(db, 'unwritten');
    expect((await listQueuedRemeasures(db, current, 'platform')).map(row => row.model)).toEqual([
      'vendor/released',
    ]);
  });

  it('cancels queued re-measures without touching claimed ones', async () => {
    insertRun('old');
    seedMeasuredPair('vendor/a');
    seedMeasuredPair('vendor/b');
    await planPromptTransportRemeasure(db, { ...current, action: 'request', prices: new Map() });
    await markProfilesRunningForRun(db, 'running', [{ model: 'vendor/a', variant: null }], current);
    const report = await planPromptTransportRemeasure(db, {
      ...current,
      action: 'cancel',
      prices: new Map(),
    });
    expect(report.changed).toBe(1);
    expect(sqlite.prepare('SELECT model, run_id FROM profile_remeasures').all()).toEqual([
      { model: 'vendor/a', run_id: 'running' },
    ]);
  });

  it('widens the frontier set with the inner-quote flag', async () => {
    insertRun('old', { router: 'frontier' });
    insertResult('old', frontierLong.id);
    insertResult('old', frontierQuoted.id);
    insertProfile('old', { router: 'frontier' });
    const plan = (frontierInnerQuotes: boolean) =>
      planPromptTransportRemeasure(db, {
        router: 'frontier',
        engineIdentity: FRONTIER_ENGINE,
        repetitions: 1,
        action: 'dry-run',
        prices: new Map(),
        frontierInnerQuotes,
      });
    expect((await plan(false)).affectedResults).toBe(1);
    expect((await plan(true)).affectedResults).toBe(2);
  });
});
