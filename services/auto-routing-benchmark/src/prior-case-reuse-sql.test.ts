import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BenchmarkPair } from '@kilocode/auto-routing-contracts';
import {
  getPendingDeciderOutput,
  markRunCompleted,
  markRunFailed,
  markStaleRunsFailed,
  reuseDeciderCaseResults,
  upsertCaseResult,
} from './db';
import type { CaseResultRow, PendingDeciderOutput } from './db';

const SCHEMA_SQL = `
  CREATE TABLE benchmark_runs (
    id TEXT PRIMARY KEY, router TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
    error TEXT, engine_identity TEXT NOT NULL, repetitions INTEGER NOT NULL
  );
  CREATE TABLE scheduler_runs (run_id TEXT PRIMARY KEY);
  CREATE TABLE case_results (
    run_id TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
    case_id TEXT NOT NULL, route_key TEXT, score REAL NOT NULL,
    latency_ms INTEGER NOT NULL, cost_usd REAL, error TEXT,
    fallback_reason TEXT, route_hit INTEGER, retried INTEGER, exit_code INTEGER,
    output_prefix TEXT, event_count INTEGER, last_event_types TEXT,
    rep INTEGER NOT NULL, timed_out INTEGER NOT NULL,
    PRIMARY KEY (run_id, model, variant, case_id, rep)
  );
  CREATE TABLE pending_decider_outputs (
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id), model TEXT NOT NULL,
    variant TEXT NOT NULL, case_id TEXT NOT NULL, rep INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY (run_id, model, variant, case_id, rep)
  );
`;

type SqliteBinding = {
  binding: D1Database;
  batchSizes: number[];
  boundCounts: number[];
};

function sqliteBinding(sqlite: DatabaseSync): SqliteBinding {
  const batchSizes: number[] = [];
  const boundCounts: number[] = [];
  const binding = {
    prepare(sqlText: string) {
      const statement = sqlite.prepare(sqlText);
      return {
        bind(...params: unknown[]) {
          boundCounts.push(params.length);
          return {
            async run() {
              const result = statement.run(...(params as never[]));
              return { success: true, results: [], meta: { changes: Number(result.changes) } };
            },
            async raw() {
              return statement.all(...(params as never[])).map(row => Object.values(row));
            },
          };
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      batchSizes.push(statements.length);
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { binding, batchSizes, boundCounts };
}

function insertRow(
  db: DatabaseSync,
  table: 'benchmark_runs' | 'case_results' | 'pending_decider_outputs',
  row: Record<string, unknown>
) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as never[]));
}

function insertRun(db: DatabaseSync, id: string, overrides: Record<string, unknown> = {}) {
  insertRow(db, 'benchmark_runs', {
    id,
    router: 'efficient',
    kind: 'decider',
    status: 'completed',
    started_at: '2026-10-01T00:00:00.000Z',
    engine_identity: 'dataset:engine',
    repetitions: 2,
    ...overrides,
  });
}

function insertCase(
  db: DatabaseSync,
  runId: string,
  caseId: string,
  overrides: Record<string, unknown> = {}
) {
  insertRow(db, 'case_results', {
    run_id: runId,
    model: 'concrete/model',
    variant: 'high',
    case_id: caseId,
    route_key: 'implementation/code_generation',
    score: 0.75,
    latency_ms: 123,
    cost_usd: 0.0123,
    error: null,
    fallback_reason: null,
    route_hit: null,
    retried: 1,
    exit_code: 0,
    output_prefix: 'original output',
    event_count: 4,
    last_event_types: '["text","completion"]',
    rep: 0,
    timed_out: 0,
    ...overrides,
  });
}

function pendingPayload(text: string): PendingDeciderOutput {
  return {
    result: {
      text,
      costUsd: 0.0234,
      latencyMs: 456,
      exitCode: 0,
      stderrTail: 'diagnostic tail',
      eventCount: 3,
      lastEventTypes: ['text', 'completion'],
      timedOut: false,
    },
    retried: true,
  };
}

function insertPending(
  db: DatabaseSync,
  runId: string,
  caseId: string,
  payload: string = JSON.stringify(pendingPayload(runId)),
  overrides: Record<string, unknown> = {}
) {
  insertRow(db, 'pending_decider_outputs', {
    run_id: runId,
    model: 'concrete/model',
    variant: 'high',
    case_id: caseId,
    rep: 0,
    payload,
    ...overrides,
  });
}

const reuseParams = {
  runId: 'destination',
  router: 'efficient',
  engineIdentity: 'dataset:engine',
  repetitions: 2,
  entries: [{ model: 'concrete/model', variant: 'high' }],
} as const;

const gradedCaseResult: CaseResultRow = {
  run_id: 'destination',
  model: 'concrete/model',
  variant: 'high',
  case_id: 'graded',
  route_key: 'implementation/code_generation',
  score: 0.8,
  latency_ms: 123,
  cost_usd: 0.0123,
  error: null,
  fallback_reason: null,
  route_hit: null,
  retried: true,
  exit_code: 0,
  output_prefix: 'graded output',
  event_count: 2,
  last_event_types: '["text","completion"]',
  rep: 0,
  timed_out: 0,
};

function results(db: DatabaseSync, runId: string) {
  return db
    .prepare('SELECT * FROM case_results WHERE run_id = ? ORDER BY model, variant, case_id, rep')
    .all(runId);
}

function pending(db: DatabaseSync, runId: string) {
  return db
    .prepare(
      'SELECT * FROM pending_decider_outputs WHERE run_id = ? ORDER BY model, variant, case_id, rep'
    )
    .all(runId);
}

describe('reuseDeciderCaseResults (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let adapter: SqliteBinding;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA_SQL);
    adapter = sqliteBinding(sqlite);
    insertRun(sqlite, 'destination', { status: 'running', started_at: '2026-10-15T00:00:00.000Z' });
  });

  afterEach(() => sqlite.close());

  it('atomically removes only the exact pending payload after inserts and updates', async () => {
    insertPending(sqlite, 'destination', 'graded');
    insertPending(sqlite, 'destination', 'graded', undefined, { rep: 1 });
    insertPending(sqlite, 'destination', 'graded', undefined, { variant: 'low' });
    insertPending(sqlite, 'destination', 'ungraded');

    await upsertCaseResult(adapter.binding, gradedCaseResult);
    expect(results(sqlite, 'destination').map(row => row.score)).toEqual([0.8]);
    const remaining = pending(sqlite, 'destination');
    expect(remaining).toHaveLength(3);
    expect(remaining.map(row => [row.case_id, row.variant, row.rep])).toEqual(
      expect.arrayContaining([
        ['graded', 'high', 1],
        ['graded', 'low', 0],
        ['ungraded', 'high', 0],
      ])
    );

    insertPending(sqlite, 'destination', 'graded');
    await upsertCaseResult(adapter.binding, { ...gradedCaseResult, score: 0 });
    expect(results(sqlite, 'destination').map(row => row.score)).toEqual([0]);
    expect(pending(sqlite, 'destination')).toEqual(remaining);
  });

  it('retains pending output and existing grades if persisting the grade fails', async () => {
    insertPending(sqlite, 'destination', 'graded');
    insertCase(sqlite, 'destination', 'graded', { score: 0.3 });
    const originalPending = pending(sqlite, 'destination');
    const originalResults = results(sqlite, 'destination');
    sqlite.exec(`
      CREATE TRIGGER reject_case_write BEFORE INSERT ON case_results
      BEGIN SELECT RAISE(ABORT, 'case write failed'); END;
    `);

    await expect(upsertCaseResult(adapter.binding, gradedCaseResult)).rejects.toThrow();
    expect(pending(sqlite, 'destination')).toEqual(originalPending);
    expect(results(sqlite, 'destination')).toEqual(originalResults);
  });

  it('rolls back the grade if deleting its pending payload fails', async () => {
    insertPending(sqlite, 'destination', 'graded');
    insertCase(sqlite, 'destination', 'graded', { score: 0.3 });
    const originalPending = pending(sqlite, 'destination');
    const originalResults = results(sqlite, 'destination');
    sqlite.exec(`
      CREATE TRIGGER reject_pending_delete BEFORE DELETE ON pending_decider_outputs
      BEGIN SELECT RAISE(ABORT, 'pending delete failed'); END;
    `);

    await expect(upsertCaseResult(adapter.binding, gradedCaseResult)).rejects.toThrow();
    expect(pending(sqlite, 'destination')).toEqual(originalPending);
    expect(results(sqlite, 'destination')).toEqual(originalResults);
  });

  it('combines partial runs, ranks each case/rep, preserves zero scores and all diagnostics', async () => {
    insertRun(sqlite, 'old');
    insertRun(sqlite, 'new-a', { status: 'failed', started_at: '2026-10-02T00:00:00.000Z' });
    insertRun(sqlite, 'new-z', { started_at: '2026-10-02T00:00:00.000Z' });
    insertCase(sqlite, 'old', 'shared', { score: 0.1 });
    insertCase(sqlite, 'old', 'shared', { rep: 1, score: 0.2 });
    insertCase(sqlite, 'old', 'old-only');
    insertCase(sqlite, 'old', 'zero', { score: 1 });
    insertCase(sqlite, 'old', 'owned', { score: 1 });
    insertCase(sqlite, 'old', 'retry');
    insertCase(sqlite, 'new-a', 'shared', { score: 0.8 });
    insertCase(sqlite, 'new-z', 'shared', {
      score: 0.9,
      fallback_reason: 'preserved diagnostic',
      route_hit: 1,
    });
    insertCase(sqlite, 'new-a', 'zero', { score: 0, cost_usd: null });
    insertCase(sqlite, 'new-a', 'retry', { error: 'CLI infrastructure failed', score: 0 });
    insertCase(sqlite, 'new-a', 'error', { error: '', score: 0 });
    insertCase(sqlite, 'new-a', 'timeout', { timed_out: 1 });
    insertCase(sqlite, 'new-a', 'exit', { exit_code: 1 });
    insertCase(sqlite, 'new-a', 'unknown-exit', { exit_code: null });
    insertCase(sqlite, 'destination', 'owned', { score: 0.3 });
    const sources = ['old', 'new-a', 'new-z'].map(id => results(sqlite, id));
    const existing = results(sqlite, 'destination')[0];

    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(5);
    const copied = results(sqlite, 'destination');
    expect(copied.map(row => [row.case_id, row.rep, row.score])).toEqual([
      ['old-only', 0, 0.75],
      ['owned', 0, 0.3],
      ['retry', 0, 0.75],
      ['shared', 0, 0.9],
      ['shared', 1, 0.2],
      ['zero', 0, 0],
    ]);
    expect(copied.find(row => row.case_id === 'owned')).toEqual(existing);
    expect(copied.find(row => row.case_id === 'shared' && row.rep === 0)).toEqual({
      ...results(sqlite, 'new-z')[0],
      run_id: 'destination',
    });
    expect(copied.find(row => row.case_id === 'zero')?.cost_usd).toBeNull();
    expect(['old', 'new-a', 'new-z'].map(id => results(sqlite, id))).toEqual(sources);
    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(0);
  });

  it('requires compatible terminal decider identity, router, repetitions and exact concrete pair', async () => {
    const incompatibleRuns = [
      { id: 'dataset', engine_identity: 'other-dataset:engine' },
      { id: 'engine', engine_identity: 'dataset:other-engine' },
      { id: 'router', router: 'frontier' },
      { id: 'reps', repetitions: 1 },
      { id: 'classifier', kind: 'classifier' },
      { id: 'running', status: 'running' },
      { id: 'queued', status: 'pending' },
    ];
    for (const { id, ...overrides } of incompatibleRuns) {
      insertRun(sqlite, id, overrides);
      insertCase(sqlite, id, id);
      insertPending(sqlite, id, `pending-${id}`);
    }
    insertRun(sqlite, 'compatible');
    insertCase(sqlite, 'compatible', 'variant', { variant: 'low' });
    insertCase(sqlite, 'compatible', 'alias', { model: 'historical/alias' });
    insertPending(sqlite, 'compatible', 'pending-variant', undefined, { variant: 'low' });
    insertPending(sqlite, 'compatible', 'pending-alias', undefined, { model: 'historical/alias' });

    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(0);
    expect(results(sqlite, 'destination')).toEqual([]);
    expect(pending(sqlite, 'destination')).toEqual([]);
  });

  it('never reuses historical alias-keyed rows even when explicitly requested', async () => {
    insertRun(sqlite, 'old');
    insertCase(sqlite, 'old', 'alias-result', { model: '~retargeted-alias' });
    insertPending(sqlite, 'old', 'alias-pending', undefined, { model: '~retargeted-alias' });
    insertCase(sqlite, 'old', 'concrete-result');
    insertPending(sqlite, 'old', 'concrete-pending');
    const originalResults = results(sqlite, 'old');
    const originalPending = pending(sqlite, 'old');
    const aliasEntry = { model: '~retargeted-alias', variant: 'high' };

    expect(
      await reuseDeciderCaseResults(adapter.binding, { ...reuseParams, entries: [aliasEntry] })
    ).toBe(0);
    expect(adapter.batchSizes).toEqual([]);
    expect(
      await reuseDeciderCaseResults(adapter.binding, {
        ...reuseParams,
        entries: [aliasEntry, ...reuseParams.entries],
      })
    ).toBe(1);
    expect(results(sqlite, 'destination').map(row => row.case_id)).toEqual(['concrete-result']);
    expect(pending(sqlite, 'destination').map(row => row.case_id)).toEqual(['concrete-pending']);
    expect(results(sqlite, 'old')).toEqual(originalResults);
    expect(pending(sqlite, 'old')).toEqual(originalPending);
  });

  it('copies latest successful ungraded payloads without destination or source graded duplicates', async () => {
    insertRun(sqlite, 'old');
    insertRun(sqlite, 'new-a', { status: 'failed', started_at: '2026-10-02T00:00:00.000Z' });
    insertRun(sqlite, 'new-z', { status: 'failed', started_at: '2026-10-02T00:00:00.000Z' });
    insertPending(sqlite, 'old', 'judge');
    insertPending(sqlite, 'old', 'judge', undefined, { rep: 1 });
    insertPending(sqlite, 'new-a', 'judge');
    const newestPayload = JSON.stringify(pendingPayload('new-z'));
    insertPending(sqlite, 'new-z', 'judge', newestPayload);
    insertPending(sqlite, 'old', 'already-pending');
    insertPending(sqlite, 'destination', 'already-pending');
    insertPending(sqlite, 'old', 'destination-graded');
    insertCase(sqlite, 'destination', 'destination-graded');
    insertPending(sqlite, 'old', 'source-graded');
    insertCase(sqlite, 'old', 'source-graded', { error: 'failed CLI' });
    insertPending(sqlite, 'old', 'newly-graded');
    insertCase(sqlite, 'new-z', 'newly-graded');
    const exitFailure = pendingPayload('failed');
    exitFailure.result.exitCode = 1;
    insertPending(sqlite, 'new-z', 'exit', JSON.stringify(exitFailure));
    insertPending(sqlite, 'old', 'retry');
    insertPending(sqlite, 'new-z', 'retry', JSON.stringify(exitFailure));
    const timedOut = pendingPayload('timed out');
    timedOut.result.timedOut = true;
    insertPending(sqlite, 'new-z', 'timeout', JSON.stringify(timedOut));
    insertPending(sqlite, 'new-z', 'invalid-json', '{invalid');
    insertPending(sqlite, 'new-z', 'unrelated-json', '{"other":true}');
    const sourcePending = ['old', 'new-a', 'new-z'].map(id => pending(sqlite, id));

    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(1);
    expect(pending(sqlite, 'destination').map(row => [row.case_id, row.rep, row.payload])).toEqual([
      ['already-pending', 0, JSON.stringify(pendingPayload('destination'))],
      ['judge', 0, newestPayload],
      ['judge', 1, JSON.stringify(pendingPayload('old'))],
      ['retry', 0, JSON.stringify(pendingPayload('old'))],
    ]);
    expect(
      await getPendingDeciderOutput(adapter.binding, {
        run_id: 'destination',
        model: 'concrete/model',
        variant: 'high',
        case_id: 'judge',
        rep: 0,
      })
    ).toEqual(pendingPayload('new-z'));
    expect(['old', 'new-a', 'new-z'].map(id => pending(sqlite, id))).toEqual(
      sourcePending.map(rows => rows.filter(row => row.case_id !== 'source-graded'))
    );
    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(0);
  });

  it('cleans legacy graded payloads only for the requested exact pair and full case key', async () => {
    insertRun(sqlite, 'old', { status: 'failed' });
    insertRun(sqlite, 'another');
    insertCase(sqlite, 'old', 'graded');
    insertPending(sqlite, 'old', 'graded');
    insertPending(sqlite, 'old', 'graded', undefined, { rep: 1 });
    insertPending(sqlite, 'old', 'graded', undefined, { variant: 'low' });
    insertPending(sqlite, 'old', 'graded', undefined, { model: 'different/model' });
    insertPending(sqlite, 'old', 'ungraded');
    insertCase(sqlite, 'another', 'ungraded');
    insertCase(sqlite, 'old', 'other-variant', { variant: 'low' });
    insertPending(sqlite, 'old', 'other-variant', undefined, { variant: 'low' });
    insertCase(sqlite, 'old', 'other-model', { model: 'different/model' });
    insertPending(sqlite, 'old', 'other-model', undefined, { model: 'different/model' });
    const originalPending = pending(sqlite, 'old');
    const originalResults = results(sqlite, 'old');

    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(2);
    expect(pending(sqlite, 'old')).toEqual(
      originalPending.filter(
        row =>
          row.model !== 'concrete/model' ||
          row.variant !== 'high' ||
          row.case_id !== 'graded' ||
          row.rep !== 0
      )
    );
    expect(results(sqlite, 'old')).toEqual(originalResults);
    expect(pending(sqlite, 'destination').map(row => [row.case_id, row.rep])).toEqual([
      ['graded', 1],
    ]);
  });

  it('leaves persisted payload schema validation to the existing loader', async () => {
    insertRun(sqlite, 'old', { status: 'failed' });
    insertPending(
      sqlite,
      'old',
      'invalid-shape',
      JSON.stringify({ result: { exitCode: 0, timedOut: false } })
    );
    expect(await reuseDeciderCaseResults(adapter.binding, reuseParams)).toBe(0);
    await expect(
      getPendingDeciderOutput(adapter.binding, {
        run_id: 'destination',
        model: 'concrete/model',
        variant: 'high',
        case_id: 'invalid-shape',
        rep: 0,
      })
    ).rejects.toThrow();
  });

  it('bounds statements and bindings across many exact pairs and normalizes null variants', async () => {
    insertRun(sqlite, 'old');
    const entries: BenchmarkPair[] = Array.from({ length: 35 }, (_, index) => ({
      model: `model/${index}`,
      variant: null,
    }));
    for (const entry of entries) {
      insertCase(sqlite, 'old', 'case', { model: entry.model, variant: '' });
      insertPending(sqlite, 'old', 'pending', undefined, { model: entry.model, variant: '' });
    }
    expect(await reuseDeciderCaseResults(adapter.binding, { ...reuseParams, entries })).toBe(35);
    expect(results(sqlite, 'destination')).toHaveLength(35);
    expect(pending(sqlite, 'destination')).toHaveLength(35);
    expect(adapter.batchSizes).toEqual([30, 30, 30, 15]);
    expect(Math.max(...adapter.boundCounts)).toBeLessThanOrEqual(100);
    expect(await reuseDeciderCaseResults(adapter.binding, { ...reuseParams, entries: [] })).toBe(0);
    expect(adapter.batchSizes).toEqual([30, 30, 30, 15]);
  });

  it('retains pending outputs when runs complete, fail or become stale', async () => {
    for (const id of ['complete', 'fail', 'stale']) {
      insertRun(sqlite, id, { status: 'running' });
      insertPending(sqlite, id, 'judge');
    }
    const before = ['complete', 'fail', 'stale'].map(id => pending(sqlite, id));
    await markRunCompleted(adapter.binding, 'complete');
    await markRunFailed(adapter.binding, 'fail', 'judge unavailable');
    await markStaleRunsFailed(adapter.binding, '2026-10-02T00:00:00.000Z');
    expect(['complete', 'fail', 'stale'].map(id => pending(sqlite, id))).toEqual(before);
    expect(
      sqlite
        .prepare("SELECT id, status FROM benchmark_runs WHERE id != 'destination' ORDER BY id")
        .all()
    ).toEqual([
      { id: 'complete', status: 'completed' },
      { id: 'fail', status: 'failed' },
      { id: 'stale', status: 'failed' },
    ]);
  });
});
