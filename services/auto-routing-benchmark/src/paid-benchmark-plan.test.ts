import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  benchmarkProjectId,
  type BenchmarkConfig,
  type CustomRouterBenchmarkContext,
} from '@kilocode/auto-routing-contracts';
import { openPaidDatabase } from '../test/paid-benchmark-d1';
import type { MeasuredCase } from './measurement-revision';
import {
  buildPaidBenchmarkPlan,
  planSlotAt,
  planSlotCount,
  planSlotIsCovered,
  planSlotIsMissing,
  stableStringify,
} from './paid-benchmark-plan';

const CATALOG = {
  data: [
    {
      id: 'vendor/alpha',
      pricing: { prompt: 1e-6, completion: 2e-6 },
      opencode: { variants: { high: { reasoning: { effort: 'high' } } } },
    },
    {
      id: 'vendor/unpriced',
      pricing: null,
    },
    {
      id: 'vendor/cheap',
      pricing: { prompt: 2e-7, completion: 4e-7 },
    },
    {
      id: '~vendor/latest',
      alias_target: 'vendor/alpha',
      pricing: null,
    },
  ],
};

const CONFIG = {
  router: 'efficient',
  deciderModels: [],
  minAccuracy: 0.7,
  accuracyNoiseBand: 0.05,
  classifierRepetitions: 1,
  classifierMaxP95LatencyMs: null,
  switchHorizonTurns: 3,
  switchCostFactor: 1,
  bestAccuracySwitchThreshold: 0,
  lowConfidenceThreshold: 0,
  benchmarkUserId: 'bench-user',
  benchmarkOrgId: 'bench-org',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  productionTokenProfile: null,
} as unknown as BenchmarkConfig;

const ENGINE = 'engine-test';
const ROUTER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = benchmarkProjectId({ scope: 'user', slug: 'pool-one', routerId: ROUTER_ID });

function fixtureCase(id: string, extra: Record<string, unknown> = {}): MeasuredCase {
  return {
    id,
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: 'Answer with the exact output.',
    userPrompt: 'const n = 1; console.log(n);',
    check: { kind: 'exact', value: '1' },
    ...extra,
  } as unknown as MeasuredCase;
}

const CASES = [fixtureCase('case-a'), fixtureCase('case-b'), fixtureCase('case-c')];

function context(entries: CustomRouterBenchmarkContext['entries']): CustomRouterBenchmarkContext {
  return {
    ownerType: 'user',
    ownerId: 'user-1',
    baseRouter: 'efficient',
    entries,
    clientEvalEntryKeys: entries
      .filter(entry => entry.kind === 'client')
      .map(entry => (entry.kind === 'client' ? `client:${entry.provider}/${entry.model}` : '')),
  };
}

function fetchCatalog(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(CATALOG), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function plan(
  input: {
    entries?: CustomRouterBenchmarkContext['entries'];
    cases?: MeasuredCase[];
  } = {}
) {
  const { db } = openPaidDatabase();
  return buildPaidBenchmarkPlan(
    { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
    {
      context: context(input.entries ?? [{ kind: 'gateway', model: 'vendor/alpha' }]),
      engineIdentity: ENGINE,
      projectId: PROJECT_ID,
      config: CONFIG,
      cases: input.cases ?? CASES,
    }
  );
}

function storeDraw(
  sqlite: DatabaseSync,
  input: {
    runId: string;
    startedAt: string;
    model: string;
    variant: string;
    caseId: string;
    rep: number;
    costUsd: number;
    promptRevision?: number;
  }
): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO benchmark_runs
        (id, router, kind, status, started_at, engine_identity, repetitions,
          measurement_revision, min_accuracy, switch_cost_factor, max_concurrency)
      VALUES (?, 'efficient', 'decider', 'completed', ?, ?, 3, 3, 0.7, 1, 80)`
    )
    .run(input.runId, input.startedAt, ENGINE);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO case_results
        (run_id, model, variant, case_id, score, latency_ms, cost_usd, rep, timed_out,
          exit_code, prompt_revision)
      VALUES (?, ?, ?, ?, 1, 10, ?, ?, 0, 0, ?)`
    )
    .run(
      input.runId,
      input.model,
      input.variant,
      input.caseId,
      input.costUsd,
      input.rep,
      input.promptRevision ?? 3
    );
}

describe('paid benchmark plan', () => {
  it('prices every missing repetition from the catalog and approves exactly the maximum', async () => {
    const outcome = await plan();
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    const { plan: ready } = outcome;
    expect(ready.pairs.map(pair => pair.model)).toEqual(['vendor/alpha']);
    expect(ready.caseIds).toEqual(['case-a', 'case-b', 'case-c']);
    expect(ready.repetitions).toBe(3);
    expect(planSlotCount(ready)).toBe(9);
    expect(ready.counts).toEqual({ reused: 0, covered: 0, shared: 0, exclusive: 9 });
    // 20k harness input tokens at $1/M plus 512 output tokens at $2/M, rounded up.
    const perCase = 20_000 * 1e-6 + 512 * 2e-6;
    expect(ready.maximumMicrodollars).toBe(Math.ceil(perCase * 1e6) * 9);
    expect(ready.estimateMicrodollars).toBe(ready.maximumMicrodollars);
    const first = planSlotAt(ready, 0);
    expect(first).toEqual({ pairIndex: 0, caseIndex: 0, rep: 0 });
    expect(planSlotIsMissing(ready, 0, 0, 0)).toBe(true);
    expect(planSlotIsCovered(ready, 0, 0, 0)).toBe(false);
  });

  it('reuses a stored draw only for its own repetition index', async () => {
    const { db, sqlite } = openPaidDatabase();
    storeDraw(sqlite, {
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      model: 'vendor/alpha',
      variant: 'high',
      caseId: 'case-a',
      rep: 0,
      costUsd: 0.02,
    });
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.counts.reused).toBe(1);
    expect(outcome.plan.counts.exclusive).toBe(8);
    // The stored draw is the measured price of that case.
    expect(outcome.plan.pairs[0]?.cost[0]).toBe(20_000);
  });

  it('ignores a draw below the case minimum revision and one invalidated after its run', async () => {
    const { db, sqlite } = openPaidDatabase();
    storeDraw(sqlite, {
      runId: 'run-old',
      startedAt: '2026-01-01T00:00:00.000Z',
      model: 'vendor/alpha',
      variant: 'high',
      caseId: 'supp-agent-term-pwd-base',
      rep: 0,
      costUsd: 0.01,
      promptRevision: 2,
    });
    storeDraw(sqlite, {
      runId: 'run-invalidated',
      startedAt: '2026-01-01T00:00:00.000Z',
      model: 'vendor/alpha',
      variant: 'high',
      caseId: 'case-b',
      rep: 1,
      costUsd: 0.01,
    });
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, invalidated_at,
            requested_at, updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'running',
          '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: [fixtureCase('supp-agent-term-pwd-base'), fixtureCase('case-b')],
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.counts.reused).toBe(0);
    expect(outcome.plan.counts.exclusive).toBe(6);
  });

  it('classifies sticky platform coverage and existing payers without charging the user', async () => {
    const { db, sqlite } = openPaidDatabase();
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, platform_covered,
            result_usable, created_at, updated_at)
        VALUES (?, 'vendor/alpha', 'high', 0, 'case-a', 'running', 1, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, platform_covered,
            result_usable, created_at, updated_at)
        VALUES (?, 'vendor/alpha', 'high', 1, 'case-a', 'queued', 0, 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_payers
          (engine_identity, model, variant, rep, case_id, generation, owner_type, owner_id,
            request_id, status, created_at, updated_at)
        VALUES (?, 'vendor/alpha', 'high', 1, 'case-a', 1, 'user', 'user-2',
          'request-other', 'eligible', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    const { plan: ready } = outcome;
    expect(ready.counts.covered).toBe(1);
    expect(ready.counts.shared).toBe(1);
    expect(ready.counts.exclusive).toBe(7);
    expect(planSlotIsCovered(ready, 0, 0, 0)).toBe(true);
    expect(planSlotIsMissing(ready, 0, 0, 0)).toBe(true);
    // One case's catalog price at the fixture's rates: 20k input tokens at $1/M plus 512
    // output tokens at $2/M = $0.021024, i.e. 21_024 microdollars.
    expect(ready.pairs[0]?.cost[0]).toBe(21_024);
    // Covered slot costs the user nothing; the shared slot splits one case cost in two, and
    // the approved maximum is the whole cost of the eight slots that are not covered.
    expect(ready.estimateMicrodollars).toBe(21_024 * 7 + 10_512);
    expect(ready.maximumMicrodollars).toBe(21_024 * 8);
  });

  it('keeps a fully reused quote at zero even when the catalog cannot price the model', async () => {
    const { db, sqlite } = openPaidDatabase();
    for (const caseId of ['case-a', 'case-b', 'case-c'])
      for (let rep = 0; rep < 3; rep += 1)
        storeDraw(sqlite, {
          runId: `run-${caseId}-${rep}`,
          startedAt: '2026-01-01T00:00:00.000Z',
          model: 'vendor/unpriced',
          variant: '',
          caseId,
          rep,
          costUsd: 0.01,
        });
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/unpriced' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.counts.reused).toBe(9);
    expect(outcome.plan.maximumMicrodollars).toBe(0);
    expect(outcome.plan.estimateMicrodollars).toBe(0);
  });

  it('fails closed when a slot that must be measured has no price', async () => {
    const outcome = await plan({ entries: [{ kind: 'gateway', model: 'vendor/unpriced' }] });
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.retryable).toBe(true);
    expect(outcome.reason).toContain('cannot price');
  });

  it('prices a long-context case from the catalog, never from a short-case mean', async () => {
    const { db, sqlite } = openPaidDatabase();
    storeDraw(sqlite, {
      runId: 'run-cheap',
      startedAt: '2026-01-01T00:00:00.000Z',
      model: 'vendor/alpha',
      variant: 'high',
      caseId: 'case-a',
      rep: 0,
      costUsd: 0.001,
    });
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: [
          fixtureCase('case-a'),
          fixtureCase('long-case', {
            longContext: { generator: 'fixture', seed: 1, targetTokens: 100_000 },
          }),
        ],
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.pairs[0]?.cost[1]).toBe(Math.ceil((100_000 * 1e-6 + 512 * 2e-6) * 1e6));
  });

  it('treats a pair already ready at this engine as serving, not as new demand', async () => {
    const { db, sqlite } = openPaidDatabase();
    // The pair is ready at this engine identity and repetition count: it serves today.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    // No revision-3 probe/pwd-base slot becomes demand for a model that already serves, and
    // no quote is produced at all: the pool keeps serving without asking for a benchmark.
    expect(outcome).toEqual({ status: 'empty' });
  });

  it('quotes only the unserved pair when the pool mixes serving and new targets', async () => {
    const { db, sqlite } = openPaidDatabase();
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run(ENGINE);
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([
          { kind: 'gateway', model: 'vendor/alpha' },
          { kind: 'gateway', model: 'vendor/cheap' },
        ]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status === 'blocked' ? `blocked: ${outcome.reason}` : outcome.status).toBe(
      'ready'
    );
    if (outcome.status !== 'ready') return;
    // The serving pair costs nothing and the new target is the only demand.
    expect(outcome.plan.counts.reused).toBe(9);
    expect(outcome.plan.counts.exclusive).toBe(9);
    expect(outcome.plan.pairs.map(pair => pair.model)).toEqual(['vendor/alpha', 'vendor/cheap']);
    expect(outcome.plan.pairs[0]?.cost.every(cost => cost === 0)).toBe(true);
    expect(outcome.plan.maximumMicrodollars).toBeGreaterThan(0);
  });

  it('still quotes a pair whose ready profile is at another engine identity', async () => {
    const { db, sqlite } = openPaidDatabase();
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at)
        VALUES ('efficient', 'vendor/alpha', 'high', 'engine-other', 3, 'ready',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.counts.exclusive).toBe(9);
    expect(outcome.plan.maximumMicrodollars).toBeGreaterThan(0);
  });

  it('resolves an alias to its concrete target and records both', async () => {
    const outcome = await plan({ entries: [{ kind: 'gateway', model: '~vendor/latest' }] });
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.pairs.map(pair => [pair.model, pair.variant])).toEqual([
      ['vendor/alpha', 'high'],
    ]);
    expect(outcome.plan.aliases).toEqual([{ model: '~vendor/latest', target: 'vendor/alpha' }]);
  });

  it('is empty for a pool with no gateway entry the worker may measure', async () => {
    const outcome = await plan({
      entries: [
        {
          kind: 'client',
          provider: 'ollama',
          model: 'qwen3:32b',
          variants: [],
          capabilities: {
            contextLength: 32_000,
            inputModalities: ['text'],
            toolCall: true,
            reasoning: false,
          },
          pricing: null,
        },
      ],
    });
    expect(outcome).toEqual({ status: 'empty' });
  });

  it('blocks a pair the catalog cannot benchmark', async () => {
    const outcome = await plan({ entries: [{ kind: 'gateway', model: 'missing/model' }] });
    expect(outcome.status).toBe('blocked');
  });
});

describe('platform ownership', () => {
  it('quotes a platform-requested pair as Kilo-covered before any case run exists', async () => {
    const { db, sqlite } = openPaidDatabase();
    // The platform subscription admitted this pair; its own run has not materialized a case.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/alpha', 'high', ?, 3, 'pending',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0)`
      )
      .run(ENGINE);
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    // Kilo pays: nothing is charged to the user and no price is needed.
    expect(outcome.plan.counts).toEqual({ reused: 0, covered: 9, shared: 0, exclusive: 0 });
    expect(outcome.plan.estimateMicrodollars).toBe(0);
    expect(outcome.plan.maximumMicrodollars).toBe(0);
  });

  it('does not treat another engine or repetition count as platform-owned', async () => {
    const { db, sqlite } = openPaidDatabase();
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, requested_at,
            updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/alpha', 'high', 'engine-other', 3, 'pending',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0)`
      )
      .run();
    const outcome = await buildPaidBenchmarkPlan(
      { db, env: { KILO_WEB_API_BASE_URL: 'https://web.test' }, fetchImpl: fetchCatalog() },
      {
        context: context([{ kind: 'gateway', model: 'vendor/alpha' }]),
        engineIdentity: ENGINE,
        projectId: PROJECT_ID,
        config: CONFIG,
        cases: CASES,
      }
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.counts.exclusive).toBe(9);
    expect(outcome.plan.maximumMicrodollars).toBeGreaterThan(0);
  });
});

describe('stableStringify', () => {
  it('ignores object key order but preserves array order', () => {
    expect(stableStringify({ b: 1, a: [1, 2] })).toBe(stableStringify({ a: [1, 2], b: 1 }));
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
  });
});
