import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaseResultRow } from './profile-failure-history';
import {
  listProvenAttempts,
  permanentByEvidence,
  summarizeProvenAttempts,
  type ProvenAttemptRow,
} from './profile-attempt-evidence';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ENGINE = 'engine-test';
const MODEL = 'vendor/model';

function result(runId: string, overrides: Partial<CaseResultRow> = {}): CaseResultRow {
  return {
    run_id: runId,
    model: MODEL,
    variant: '',
    case_id: 'case-a',
    route_key: null,
    score: 0,
    latency_ms: 10,
    cost_usd: 0.01,
    input_tokens: 5,
    cached_input_tokens: 0,
    output_tokens: 9,
    reasoning_tokens: 0,
    error: null,
    fallback_reason: null,
    route_hit: null,
    retried: null,
    exit_code: 0,
    output_prefix: '{"ok":true}',
    event_count: 3,
    last_event_types: '["done"]',
    tool_calls: 0,
    tool_names: '[]',
    step_count: 1,
    final_finish_reason: 'stop',
    rep: 0,
    timed_out: 0,
    prompt_revision: 2,
    ...overrides,
  };
}

/** node:sqlite has no boolean binding; these two result columns are boolean|null in D1. */
function sqliteBoolean(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

describe('proven attempt evidence (read-only, production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  afterEach(() => sqlite.close());

  function insertRun(runId: string, at: number, status = 'completed') {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at,
          min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity)
         VALUES (?, 'efficient', 'decider', 'platform', ?, ?, 0.7, 3, 0, 1, ?)`
      )
      .run(runId, status, iso(at), ENGINE);
  }

  function insertRunModel(runId: string, enqueued = 1, model = MODEL) {
    sqlite
      .prepare('INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, ?, ?)')
      .run(runId, model, '', enqueued);
  }

  function insertResult(runId: string, overrides: Partial<CaseResultRow> = {}) {
    const row = result(runId, overrides);
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
          cost_usd, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, error,
          fallback_reason, route_hit, retried, exit_code, output_prefix, event_count,
          last_event_types, tool_calls, tool_names, step_count, final_finish_reason, rep,
          timed_out, prompt_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.run_id,
        row.model,
        row.variant,
        row.case_id,
        row.route_key,
        row.score,
        row.latency_ms,
        row.cost_usd,
        row.input_tokens,
        row.cached_input_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.error,
        row.fallback_reason,
        sqliteBoolean(row.route_hit),
        sqliteBoolean(row.retried),
        row.exit_code,
        row.output_prefix,
        row.event_count,
        row.last_event_types,
        row.tool_calls,
        row.tool_names,
        row.step_count,
        row.final_finish_reason,
        row.rep,
        row.timed_out,
        row.prompt_revision
      );
  }

  function insertLaneFailure(runId: string) {
    sqlite
      .prepare(
        `INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at,
          failure_class) VALUES (?, ?, '', 0, 0, 0, ?, 'unknown')`
      )
      .run(runId, MODEL, iso(T0));
  }

  async function history(sinceIso = iso(T0 - HOUR), model?: string) {
    return listProvenAttempts(db, {
      router: 'efficient',
      engineIdentity: ENGINE,
      sinceIso,
      ...(model ? { model } : {}),
    });
  }

  it('proves progress from a fresh valid result and failure only from a dead lane', async () => {
    insertRun('progress', T0);
    insertRunModel('progress');
    insertResult('progress', { score: 0 });

    insertRun('lane', T0 + HOUR);
    insertRunModel('lane');
    insertLaneFailure('lane');

    // A dead lane with the earlier run's exact result row: a copy is not progress.
    insertRun('lane-copied', T0 + 2 * HOUR);
    insertRunModel('lane-copied');
    insertLaneFailure('lane-copied');
    insertResult('lane-copied');

    // The same copied row and no lane death: no durable proof either way.
    insertRun('copied', T0 + 3 * HOUR);
    insertRunModel('copied');
    insertResult('copied');

    // A run that enqueued the pair but left nothing durable: unknown.
    insertRun('empty', T0 + 4 * HOUR);
    insertRunModel('empty');

    const rows = await history();
    expect(rows.map(row => [row.runId, row.outcome])).toEqual([
      ['empty', 'unknown'],
      ['copied', 'unknown'],
      ['lane-copied', 'failed'],
      ['lane', 'failed'],
      ['progress', 'progress'],
    ]);
    expect(summarizeProvenAttempts(rows)).toEqual([
      {
        model: MODEL,
        variant: '',
        provenProgressRuns: 1,
        provenFailedRuns: 2,
        unknownRuns: 2,
        provenFailedTail: 0,
        tailStop: 'unknown',
      },
    ]);
  });

  it('counts a newest unbroken proven-failed tail and stops at progress or unknown', async () => {
    insertRun('base', T0);
    insertRunModel('base');
    insertResult('base');
    for (let index = 1; index <= 6; index++) {
      insertRun(`fail-${index}`, T0 + index * HOUR);
      insertRunModel(`fail-${index}`);
      insertLaneFailure(`fail-${index}`);
    }
    const summaries = summarizeProvenAttempts(await history());
    expect(summaries[0]).toMatchObject({
      provenProgressRuns: 1,
      provenFailedRuns: 6,
      provenFailedTail: 6,
      tailStop: 'progress',
    });
    expect(permanentByEvidence(summaries)).toHaveLength(1);

    // An unknown run above the tail could hide progress, so the proven tail stops there.
    insertRun('mystery', T0 + 7 * HOUR);
    insertRunModel('mystery');
    const afterUnknown = summarizeProvenAttempts(await history());
    expect(afterUnknown[0]).toMatchObject({ provenFailedTail: 0, tailStop: 'unknown' });
    expect(permanentByEvidence(afterUnknown)).toEqual([]);
  });

  it('excludes unattempted entries, other models and runs before the bound', async () => {
    insertRun('skipped', T0);
    insertRunModel('skipped', 0);
    insertResult('skipped');

    insertRun('other', T0 + HOUR);
    insertRunModel('other', 1, 'vendor/other');
    insertResult('other', { model: 'vendor/other' });

    insertRun('old', T0 - 10 * HOUR);
    insertRunModel('old');
    insertResult('old');

    expect((await history(iso(T0))).map(row => row.runId)).toEqual(['other']);
    const other = await history(iso(T0 - HOUR), 'vendor/other');
    expect(other.map(row => row.runId)).toEqual(['other']);
  });

  it('reads only: the attempt-history ledger is untouched', async () => {
    insertRun('run-1', T0);
    insertRunModel('run-1');
    await history();
    const table = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile_attempt_history'`
      )
      .get();
    expect(
      table
        ? Number(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_attempt_history').get()?.n)
        : 0
    ).toBe(0);
  });
});

describe('proven attempt summary', () => {
  const row = (runId: string, outcome: ProvenAttemptRow['outcome']): ProvenAttemptRow => ({
    model: 'm',
    variant: '',
    runId,
    startedAt: `2026-11-20T00:00:0${runId.length}.000Z`,
    outcome,
  });

  it('never invents a failure from unknown history', () => {
    const summaries = summarizeProvenAttempts([
      row('a', 'unknown'),
      row('b', 'failed'),
      row('c', 'failed'),
      row('d', 'failed'),
      row('e', 'failed'),
      row('f', 'failed'),
      row('g', 'failed'),
    ]);
    expect(summaries[0]).toMatchObject({ provenFailedTail: 0, tailStop: 'unknown' });
    expect(permanentByEvidence(summaries)).toEqual([]);
  });

  it('is permanent only at the budget of proven failures', () => {
    const five = [1, 2, 3, 4, 5].map(index => row(`r${index}`, 'failed'));
    expect(permanentByEvidence(summarizeProvenAttempts(five))).toEqual([]);
    const six = [...five, row('r6', 'failed')];
    expect(permanentByEvidence(summarizeProvenAttempts(six))[0]?.provenFailedTail).toBe(6);
  });
});
