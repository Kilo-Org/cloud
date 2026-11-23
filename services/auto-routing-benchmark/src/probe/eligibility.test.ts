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
  overrides: {
    promptRevision?: number;
    routeKey?: string | null;
    rep?: number;
    model?: string;
    variant?: string;
  } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
        cost_usd, error, exit_code, tool_calls, tool_names, step_count, final_finish_reason,
        rep, timed_out, prompt_revision)
       VALUES (?, ?, ?, ?, ?, 1, 100, 0.01, NULL, 0, 1, '["bash"]', 1, 'tool-calls', ?, 0, ?)`
    )
    .run(
      runId,
      overrides.model ?? MODEL,
      overrides.variant ?? VARIANT,
      caseId,
      overrides.routeKey === undefined ? 'implementation/code_generation' : overrides.routeKey,
      overrides.rep ?? 0,
      overrides.promptRevision ?? 2
    );
}

/** The run-scoped statement this pair-scoped count replaced, kept to diff the two on real rows. */
function countProbeCasesByRun(
  sqlite: DatabaseSync,
  runIds: readonly string[],
  caseIds: readonly string[],
  revision: number
) {
  return sqlite
    .prepare(
      `SELECT run_id, model, variant, COUNT(DISTINCT case_id) AS probes
       FROM case_results
       WHERE run_id IN (SELECT value FROM json_each(?))
         AND case_id IN (SELECT value FROM json_each(?))
         AND prompt_revision >= ?
       GROUP BY run_id, model, variant`
    )
    .all(JSON.stringify(runIds), JSON.stringify(caseIds), revision) as {
    run_id: string;
    model: string;
    variant: string;
    probes: number;
  }[];
}

const probeRowKey = (row: { run_id: string; model: string; variant: string }) =>
  `${row.run_id}\u0000${row.model}\u0000${row.variant}`;

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

  it('counts each named pair separately, including one with no results at all', async () => {
    // A second pair of the same run must not contribute to the first pair's count, and a
    // pair with no rows must still come back (LEFT JOIN) with zero rather than vanishing.
    const [first, second] = PROBE_CASES;
    insertCase(sqlite, 'rev2', first!.id, { promptRevision: PROBE_REVISION });
    insertCase(sqlite, 'rev2', second!.id, {
      model: 'vendor/other',
      variant: 'low',
      promptRevision: PROBE_REVISION,
    });
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
      rows
        .toSorted((a, b) => a.model.localeCompare(b.model))
        .map(row => [row.model, row.variant, row.probes])
    ).toEqual([
      [MODEL, VARIANT, 1],
      ['vendor/absent', '', 0],
      ['vendor/other', 'low', 1],
    ]);
  });

  it('returns the run-scoped count it replaced on real rows: repetitions and stale revisions', async () => {
    // Differential over the rows that make the two shapes disagree if the pairing is wrong:
    // repetitions of one case (COUNT(DISTINCT case_id) must not grow), a probe case stored at
    // an older prompt revision (must not count), a second pair in the same run, and a pair
    // whose run holds nothing.
    const [first, second] = PROBE_CASES;
    const caseIds = PROBE_CASES.map(probeCase => probeCase.id);
    for (const rep of [0, 1, 2]) {
      insertCase(sqlite, 'rev2', first!.id, { rep, promptRevision: PROBE_REVISION });
    }
    insertCase(sqlite, 'rev2', second!.id, { promptRevision: PROBE_REVISION - 1 });
    insertCase(sqlite, 'rev2', second!.id, { model: 'vendor/other', variant: 'low', rep: 0 });
    insertCase(sqlite, 'rev2', second!.id, { model: 'vendor/other', variant: 'low', rep: 1 });
    insertCase(sqlite, 'rev3', first!.id, { model: 'vendor/other', variant: 'high' });

    const pairs = [
      { runId: 'rev2', model: MODEL, variant: VARIANT },
      { runId: 'rev2', model: 'vendor/other', variant: 'low' },
      { runId: 'rev2', model: 'vendor/absent', variant: '' },
      { runId: 'rev3', model: 'vendor/other', variant: 'high' },
      { runId: 'rev3', model: 'vendor/other', variant: 'low' },
    ];
    const pairScoped = await countProbeCaseResults(db, {
      pairs,
      caseIds,
      revision: PROBE_REVISION,
    });
    const runScoped = new Map(
      countProbeCasesByRun(sqlite, ['rev2', 'rev3'], caseIds, PROBE_REVISION).map(row => [
        probeRowKey(row),
        row.probes,
      ])
    );

    expect(pairScoped.map(probeRowKey).toSorted()).toEqual(
      pairs
        .map(pair => probeRowKey({ run_id: pair.runId, model: pair.model, variant: pair.variant }))
        .toSorted()
    );
    for (const row of pairScoped) {
      expect(row.probes).toBe(runScoped.get(probeRowKey(row)) ?? 0);
    }
    // Same "complete" predicate: one distinct probe case is not every probe case.
    expect(pairScoped.find(row => row.model === MODEL)!.probes).toBe(1);
  });

  it('counts across more pairs than one statement binds', async () => {
    // 31 pairs crosses PROBE_CASE_PAIR_BATCH_SIZE (30) while staying under D1's 100 variables;
    // every pair must still be reported exactly once.
    const pairs = Array.from({ length: 31 }, (_, index) => ({
      runId: 'rev2',
      model: `vendor/model-${index}`,
      variant: 'low',
    }));
    insertCase(sqlite, 'rev2', PROBE_CASES[0]!.id, {
      model: 'vendor/model-30',
      variant: 'low',
      promptRevision: PROBE_REVISION,
    });
    const rows = await countProbeCaseResults(db, {
      pairs,
      caseIds: PROBE_CASES.map(probeCase => probeCase.id),
      revision: PROBE_REVISION,
    });
    expect(rows).toHaveLength(31);
    expect(new Set(rows.map(probeRowKey)).size).toBe(31);
    expect(rows.find(row => row.model === 'vendor/model-30')!.probes).toBe(1);
    expect(rows.filter(row => row.probes === 0)).toHaveLength(30);
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
