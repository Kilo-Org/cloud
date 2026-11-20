import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { benchmarkPairKey } from '@kilocode/auto-routing-contracts';
import { countProbeCaseResults, reuseDeciderCaseResults } from '../db';
import { DECIDER_CASES } from '../datasets/decider-cases';
import { PROBE_CASES } from '../datasets/probe-cases';
import {
  deciderCasesForRouter,
  minimumCaseRevisions,
  PROBE_REVISION,
} from '../measurement-revision';
import type { OfflineSweep } from '../scoreboard/schema';
import { probeEligibilityKvKey, routingTableVersionKvKey } from '../routing-table-cache-keys';
import {
  PROBE_ROUTE_KEYS,
  agenticRoutesWithoutCandidates,
  dropIneligibleAgenticResults,
  dropIneligibleAgenticSummaries,
  pairsMissingProbeResults,
} from './eligibility';

const SCHEMA_SQL = `
  CREATE TABLE benchmark_runs (
    id TEXT PRIMARY KEY, router TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
    error TEXT, engine_identity TEXT NOT NULL, repetitions INTEGER NOT NULL
  );
  CREATE TABLE benchmark_profiles (
    router TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
    engine_identity TEXT NOT NULL, repetitions INTEGER NOT NULL, invalidated_at TEXT
  );
  CREATE TABLE case_results (
    run_id TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
    case_id TEXT NOT NULL, route_key TEXT, score REAL NOT NULL,
    latency_ms INTEGER NOT NULL, cost_usd REAL, error TEXT,
    input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    fallback_reason TEXT, route_hit INTEGER, retried INTEGER, exit_code INTEGER,
    output_prefix TEXT, event_count TEXT, last_event_types TEXT,
    tool_calls INTEGER, tool_names TEXT, step_count INTEGER, final_finish_reason TEXT,
    rep INTEGER NOT NULL, timed_out INTEGER NOT NULL, prompt_revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (run_id, model, variant, case_id, rep)
  );
  CREATE TABLE pending_decider_outputs (
    run_id TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
    case_id TEXT NOT NULL, rep INTEGER NOT NULL, payload TEXT NOT NULL,
    prompt_revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (run_id, model, variant, case_id, rep)
  );
`;

function binding(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sqlText: string) {
      const statement = sqlite.prepare(sqlText);
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              return { results: statement.all(...(params as never[])) };
            },
            async run() {
              const outcome = statement.run(...(params as never[]));
              return { success: true, results: [], meta: { changes: Number(outcome.changes) } };
            },
            async raw() {
              return statement.all(...(params as never[])).map(row => Object.values(row));
            },
          };
        },
        async all() {
          return { results: statement.all() };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}

const MODEL = 'meta/muse-ember';
const VARIANT = 'high';

function insertCase(
  sqlite: DatabaseSync,
  runId: string,
  caseId: string,
  overrides: { promptRevision?: number; routeKey?: string | null } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
        cost_usd, error, exit_code, tool_calls, tool_names, step_count, final_finish_reason,
        rep, timed_out, prompt_revision)
       VALUES (?, ?, ?, ?, ?, 1, 100, 0.01, NULL, 0, 1, '["bash"]', 1, 'tool-calls', 0, 0, ?)`
    )
    .run(
      runId,
      MODEL,
      VARIANT,
      caseId,
      overrides.routeKey === undefined ? 'implementation/code_generation' : overrides.routeKey,
      overrides.promptRevision ?? 2
    );
}

describe('probe eligibility (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA_SQL);
    db = binding(sqlite);
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, status, started_at, engine_identity, repetitions)
         VALUES ('rev2', 'efficient', 'decider', 'completed', '2026-11-01T00:00:00.000Z', 'engine', 1)`
      )
      .run();
  });

  afterEach(() => sqlite.close());

  it('schedules exactly the probe cases and pwd-base for a pair fully measured at revision 2', async () => {
    for (const benchCase of DECIDER_CASES) {
      insertCase(sqlite, 'rev2', benchCase.id);
    }
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, status, started_at, engine_identity, repetitions)
         VALUES ('rev3', 'efficient', 'decider', 'running', '2026-11-20T00:00:00.000Z', 'engine', 1)`
      )
      .run();
    const copied = await reuseDeciderCaseResults(db, {
      runId: 'rev3',
      router: 'efficient',
      engineIdentity: 'engine',
      repetitions: 1,
      entries: [{ model: MODEL, variant: VARIANT }],
      minimumRevisions: minimumCaseRevisions('efficient', PROBE_REVISION),
    });
    expect(copied).toBe(DECIDER_CASES.length - 1);

    const scheduled = deciderCasesForRouter('efficient', PROBE_REVISION)
      .map(benchCase => benchCase.id)
      .filter(
        caseId =>
          !sqlite
            .prepare('SELECT 1 FROM case_results WHERE run_id = ? AND case_id = ?')
            .get('rev3', caseId)
      );
    expect(scheduled.toSorted()).toEqual(
      [...PROBE_CASES.map(probeCase => probeCase.id), 'supp-agent-term-pwd-base'].toSorted()
    );
  });

  it('schedules no probe case for a run under the probe revision', async () => {
    const minimums = minimumCaseRevisions('efficient', PROBE_REVISION - 1);
    expect(Object.keys(minimums).filter(id => id.startsWith('probe-'))).toEqual([]);
    for (const probeCase of PROBE_CASES) expect(minimums[probeCase.id]).toBeUndefined();
    expect(minimums['supp-agent-term-pwd-base']).toBeUndefined();
  });

  it('counts only probe results at the probe revision per pair', async () => {
    const [first, second] = PROBE_CASES;
    insertCase(sqlite, 'rev2', first!.id, { promptRevision: 2 });
    insertCase(sqlite, 'rev2', second!.id, { promptRevision: 3 });
    const rows = await countProbeCaseResults(db, {
      pairs: [{ runId: 'rev2', model: MODEL, variant: VARIANT }],
      caseIds: PROBE_CASES.map(probeCase => probeCase.id),
      revision: PROBE_REVISION,
    });
    expect(rows).toEqual([{ run_id: 'rev2', model: MODEL, variant: VARIANT, probes: 1 }]);
  });

  it('counts each pair separately and never another pair of the same run', async () => {
    // A second pair measured in the same run must not contribute to the first pair's count,
    // and a pair with no results must still come back (LEFT JOIN) with zero.
    const [first, second] = PROBE_CASES;
    insertCase(sqlite, 'rev2', first!.id, { promptRevision: 3 });
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
          cost_usd, error, exit_code, tool_calls, tool_names, step_count, final_finish_reason,
          rep, timed_out, prompt_revision)
         VALUES ('rev2', 'vendor/other', 'low', ?, 'implementation/code_generation', 1, 100, 0.01,
           NULL, 0, 1, '["bash"]', 1, 'tool-calls', 0, 0, 3)`
      )
      .run(second!.id);
    const rows = await countProbeCaseResults(db, {
      pairs: [
        { runId: 'rev2', model: MODEL, variant: VARIANT },
        { runId: 'rev2', model: 'vendor/other', variant: 'low' },
        { runId: 'rev2', model: 'vendor/absent', variant: '' },
      ],
      caseIds: PROBE_CASES.map(probeCase => probeCase.id),
      revision: PROBE_REVISION,
    });
    expect(
      rows.toSorted((a, b) => a.model.localeCompare(b.model)).map(row => [row.model, row.probes])
    ).toEqual([
      ['meta/muse-ember', 1],
      ['vendor/absent', 0],
      ['vendor/other', 1],
    ]);
  });

  it('counts across more pairs than one batch holds', async () => {
    // 31 pairs crosses PROBE_CASE_PAIR_BATCH_SIZE (30); every pair must still be reported.
    const pairs = Array.from({ length: 31 }, (_, index) => ({
      runId: 'rev2',
      model: `vendor/model-${index}`,
      variant: 'low',
    }));
    const rows = await countProbeCaseResults(db, {
      pairs,
      caseIds: PROBE_CASES.map(probeCase => probeCase.id),
      revision: PROBE_REVISION,
    });
    expect(rows).toHaveLength(31);
    expect(rows.every(row => row.probes === 0)).toBe(true);
  });

  it('declares a pair probe-complete only with every probe case, and re-admits it once measured', async () => {
    for (const probeCase of PROBE_CASES.slice(1)) {
      insertCase(sqlite, 'rev2', probeCase.id, { promptRevision: 3 });
    }
    const entries = [{ entry: { model: MODEL, variant: VARIANT }, runId: 'rev2' }];
    expect(await pairsMissingProbeResults(db, { entries, revision: PROBE_REVISION })).toEqual(
      new Set([benchmarkPairKey({ model: MODEL, variant: VARIANT })])
    );
    insertCase(sqlite, 'rev2', PROBE_CASES[0]!.id, { promptRevision: 3 });
    expect(await pairsMissingProbeResults(db, { entries, revision: PROBE_REVISION })).toEqual(
      new Set()
    );
  });

  function fakeKv(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const kv = {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    } as unknown as KVNamespace;
    return { store, kv };
  }

  const entries = [{ entry: { model: MODEL, variant: VARIANT }, runId: 'rev2' }];
  const pairKey = benchmarkPairKey({ model: MODEL, variant: VARIANT });

  it('serves the cached answer without scanning, and only for the publication it was stored under', async () => {
    for (const probeCase of PROBE_CASES) {
      insertCase(sqlite, 'rev2', probeCase.id, { promptRevision: 3 });
    }
    const { store, kv } = fakeKv({ [routingTableVersionKvKey('efficient')]: 'v1 t1' });
    // Exit the scan entirely: a cache hit must not reach D1.
    let scanned = 0;
    const counting = binding(sqlite);
    const spy = {
      prepare(sqlText: string) {
        scanned += 1;
        return counting.prepare(sqlText);
      },
    } as unknown as D1Database;
    const params = {
      entries,
      revision: PROBE_REVISION,
      router: 'efficient' as const,
      env: { AUTO_ROUTING_CONFIG: kv },
      cacheFullSet: true,
    };
    expect(await pairsMissingProbeResults(spy, params)).toEqual(new Set());
    const afterScan = scanned;
    expect(afterScan).toBeGreaterThan(0);
    expect(JSON.parse(store.get(probeEligibilityKvKey('efficient'))!)).toEqual({
      token: 'v1 t1',
      ineligible: [],
    });
    // Second call: cached, so no statement is prepared.
    expect(await pairsMissingProbeResults(spy, params)).toEqual(new Set());
    expect(scanned).toBe(afterScan);
    // A newer publication invalidates it and forces a fresh scan.
    store.set(routingTableVersionKvKey('efficient'), 'v2 t2');
    expect(await pairsMissingProbeResults(spy, params)).toEqual(new Set());
    expect(scanned).toBeGreaterThan(afterScan);
  });

  it('never stores an answer computed over a subset of pairs', async () => {
    const { store, kv } = fakeKv({ [routingTableVersionKvKey('efficient')]: 'v1 t1' });
    // Not probe-complete, and read by the single-owner custom-router path.
    expect(
      await pairsMissingProbeResults(db, {
        entries,
        revision: PROBE_REVISION,
        router: 'efficient',
        env: { AUTO_ROUTING_CONFIG: kv },
      })
    ).toEqual(new Set([pairKey]));
    // No entry was written, so a later full-set reader cannot inherit a subset answer.
    expect(store.has(probeEligibilityKvKey('efficient'))).toBe(false);
  });

  it('scans when the cache is unavailable instead of failing the request', async () => {
    for (const probeCase of PROBE_CASES) {
      insertCase(sqlite, 'rev2', probeCase.id, { promptRevision: 3 });
    }
    const broken = {
      async get() {
        throw new Error('kv unavailable');
      },
      async put() {
        throw new Error('kv unavailable');
      },
    } as unknown as KVNamespace;
    expect(
      await pairsMissingProbeResults(db, {
        entries,
        revision: PROBE_REVISION,
        router: 'efficient',
        env: { AUTO_ROUTING_CONFIG: broken },
        cacheFullSet: true,
      })
    ).toEqual(new Set());
  });
});

describe('route-scoped eligibility', () => {
  const pair = { model: MODEL, variant: VARIANT };
  const key = benchmarkPairKey(pair);
  const agenticRoute = PROBE_ROUTE_KEYS[0]!;

  const perCaseResults: OfflineSweep['pairs'] = [
    {
      model: MODEL,
      variant: VARIANT,
      results: [
        {
          caseId: 'probe',
          routeKey: agenticRoute,
          rep: 0,
          score: 1,
          costUsd: 0.01,
          latencyMs: 100,
          error: null,
          graderCostUsd: 0,
          split: 'train',
        },
        {
          caseId: 'impl',
          routeKey: 'implementation/code_generation',
          rep: 0,
          score: 1,
          costUsd: 0.01,
          latencyMs: 100,
          error: null,
          graderCostUsd: 0,
          split: 'train',
        },
      ],
    },
  ];

  const summaries = [
    {
      model: MODEL,
      variant: VARIANT,
      routeKey: agenticRoute,
      accuracy: 1,
      cases: 21,
      avgCostUsd: 0.01,
      avgInputTokens: 1,
      avgCachedInputTokens: 0,
      avgOutputTokens: 1,
      avgReasoningTokens: 0,
      avgLatencyMs: 100,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      errors: 0,
      timeouts: 0,
      routeAccuracy: null,
      runId: 'rev2',
    },
    {
      model: MODEL,
      variant: VARIANT,
      routeKey: 'implementation/code_generation' as const,
      accuracy: 1,
      cases: 4,
      avgCostUsd: 0.01,
      avgInputTokens: 1,
      avgCachedInputTokens: 0,
      avgOutputTokens: 1,
      avgReasoningTokens: 0,
      avgLatencyMs: 100,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      errors: 0,
      timeouts: 0,
      routeAccuracy: null,
      runId: 'rev2',
    },
  ];

  it('drops only the agentic results and summaries of an ineligible pair', () => {
    expect(dropIneligibleAgenticResults(perCaseResults, new Set([key]))).toEqual([
      {
        model: MODEL,
        variant: VARIANT,
        results: [perCaseResults[0]!.results[1]],
      },
    ]);
    expect(
      dropIneligibleAgenticSummaries(summaries, new Set([key])).map(summary => summary.routeKey)
    ).toEqual(['implementation/code_generation']);
    expect(dropIneligibleAgenticSummaries(summaries, new Set())).toEqual(summaries);
  });

  it('names the agentic routes a build would leave empty', () => {
    const onlyNonAgentic = summaries.filter(
      summary => summary.routeKey === 'implementation/code_generation'
    );
    expect(agenticRoutesWithoutCandidates(onlyNonAgentic)).toEqual([...PROBE_ROUTE_KEYS]);
    expect(agenticRoutesWithoutCandidates(summaries)).toEqual(PROBE_ROUTE_KEYS.slice(1));
  });
});
