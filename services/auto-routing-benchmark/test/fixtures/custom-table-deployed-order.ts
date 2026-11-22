/**
 * Fixture shared by `src/custom-routing-table-deployed-order.test.ts` and the generator
 * that rendered its golden file (`scripts/render-deployed-custom-table.ts`). The test seeds
 * these rows into the migrated SQLite database in a fixed shuffled order and compares the
 * assembled table to the golden file rendered by the DEPLOYED code (commit 0487d998).
 *
 * The rows are exactly tied: two single-variant models on every ranking key, and
 * one model whose two variants tie with each other. Identical values are the
 * point — only a row's order can decide which candidate comes first.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  BenchmarkConfig,
  ComplexityLabels,
  CustomRouterBenchmarkContext,
  TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { ComplexityLabelsSchema } from '@kilocode/auto-routing-contracts';
import caseComplexity from '../../src/datasets/case-complexity.json';
import { computeEngineIdentity } from '../../src/run';
import type { OfflineSweep } from '../../src/scoreboard/schema';
import type { BenchmarkModelSummaryWithRun } from '../../src/db';

export const DEPLOYED_COMMIT = '0487d998b60cbea224bf7ed69d5f6b6353b93de4';

export const ROUTE_A = 'implementation/code_generation' as const;
export const ROUTE_B = 'planning_design/technical_planning' as const;

/** Two models with a single null variant that tie on every ranking key. */
export const TIED_MODELS = ['vendor/aaa', 'vendor/zzz'] as const;
/** One model whose two variants tie on every ranking key. */
export const VARIANT_MODEL = 'vendor/variants';
export const VARIANT_KEYS = ['high', 'low'] as const;

export const FIXTURE_RUN_ID = 'run-deployed-order';

export const FIXTURE_CONFIG: BenchmarkConfig = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  classifierModels: ['typesafe/jev-1.13'],
  deciderModels: [{ id: 'vendor/platform' }],
  minAccuracy: 0.7,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  updatedAt: null,
  updatedBy: null,
};

export const FIXTURE_ENGINE = computeEngineIdentity('decider', 'efficient');

export const FIXTURE_SOURCE = {
  catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
  // The catalog lists the variant keys in pair-key order (high before low), so the
  // deployed pool-order projection and the primary-key order agree on this tie.
  fetchImpl: async () =>
    Response.json({
      data: [
        { id: 'vendor/aaa', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'vendor/zzz', pricing: { prompt: '0.000001', completion: '0.000002' } },
        {
          id: 'vendor/variants',
          opencode: {
            variants: {
              high: { reasoning: { enabled: true, effort: 'high' } },
              low: { reasoning: { enabled: true, effort: 'low' } },
            },
          },
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ],
    } as const),
  now: new Date('2026-11-22T00:00:00.000Z'),
};

/** The pool order whose case-pair projection is primary-key order. */
export const CANONICAL_POOL = ['vendor/aaa', VARIANT_MODEL, 'vendor/zzz'] as const;

/** Every pool order; the assembled table must not depend on which one a caller sends. */
export const POOL_PERMUTATIONS: readonly (readonly string[])[] = [
  ['vendor/aaa', 'vendor/variants', 'vendor/zzz'],
  ['vendor/aaa', 'vendor/zzz', 'vendor/variants'],
  ['vendor/variants', 'vendor/aaa', 'vendor/zzz'],
  ['vendor/variants', 'vendor/zzz', 'vendor/aaa'],
  ['vendor/zzz', 'vendor/aaa', 'vendor/variants'],
  ['vendor/zzz', 'vendor/variants', 'vendor/aaa'],
];

/** Six cases in the low complexity bucket and six in the high one. */
export const LOW_CASES = [
  'impl-feat-ternary-parity',
  'impl-feat-array-pipeline',
  'impl-feat-closure-counter',
  'impl-feat-recursion-fib',
  'impl-feat-this-binding',
  'impl-gen-package-manifest',
];
export const HIGH_CASES = [
  'invest-code-v2-queue-rejection-propagation',
  'invest-ext-v2-quota-reserved-costs',
  'invest-ext-v2-durability-ack-levels',
  'invest-ext-v2-delivery-guarantee-scope',
  'invest-ext-v2-benchmark-confounding-sources',
  'plan-steps-v2-expand-contract-sequence',
];

export const FIXTURE_COMPLEXITY_LABELS: ComplexityLabels =
  ComplexityLabelsSchema.parse(caseComplexity);

/** Every measured pair, in the primary-key order of `model_summaries`. */
export const FIXTURE_PAIRS: readonly { model: string; variant: string | null }[] = [
  { model: 'vendor/aaa', variant: null },
  { model: VARIANT_MODEL, variant: 'high' },
  { model: VARIANT_MODEL, variant: 'low' },
  { model: 'vendor/zzz', variant: null },
];

export const FIXTURE_ROUTES: readonly TaxonomyRouteKey[] = [ROUTE_A, ROUTE_B];

export function fixtureContext(entries: readonly string[]): CustomRouterBenchmarkContext {
  return {
    ownerType: 'user',
    ownerId: 'user-deployed-order',
    baseRouter: 'efficient',
    entries: entries.map(model => ({ kind: 'gateway', model })),
    clientEvalEntryKeys: [],
  };
}

/** Ready entries, one per measured pair, in primary-key order. */
export function fixtureReadyEntries() {
  return FIXTURE_PAIRS.map(pair => ({ entry: { ...pair }, runId: FIXTURE_RUN_ID }));
}

/** Per-route summaries for every measured pair; all values tie exactly. */
export function fixtureSummaries(): BenchmarkModelSummaryWithRun[] {
  return FIXTURE_PAIRS.flatMap(pair =>
    FIXTURE_ROUTES.map<BenchmarkModelSummaryWithRun>(routeKey => ({
      model: pair.model,
      variant: pair.variant,
      routeKey,
      accuracy: 0.9,
      avgCostUsd: 0.001,
      avgInputTokens: null,
      avgCachedInputTokens: null,
      avgOutputTokens: null,
      avgReasoningTokens: null,
      avgLatencyMs: 800,
      p50LatencyMs: 800,
      p95LatencyMs: 900,
      cases: 20,
      errors: 0,
      timeouts: 0,
      routeAccuracy: null,
      runId: FIXTURE_RUN_ID,
    }))
  );
}

/** Graded cases for every measured pair, six per complexity bucket. */
export function fixturePerCaseResults(): OfflineSweep['pairs'] {
  return FIXTURE_PAIRS.map(pair => ({
    model: pair.model,
    variant: pair.variant,
    results: [...LOW_CASES, ...HIGH_CASES].map(caseId => ({
      caseId,
      rep: 0,
      routeKey: ROUTE_A,
      split: 'train' as const,
      score: 0.9,
      costUsd: 0.001,
      graderCostUsd: 0,
      latencyMs: 100,
      error: null,
    })),
  }));
}

type ProfileRow = { model: string; variant: string };

function profileRows(): ProfileRow[] {
  return FIXTURE_PAIRS.map(pair => ({
    model: pair.model,
    variant: pair.variant ?? '',
  }));
}

type CaseRow = { model: string; variant: string; caseId: string; routeKey: string };

function caseRows(): CaseRow[] {
  return FIXTURE_PAIRS.flatMap(pair =>
    [...LOW_CASES, ...HIGH_CASES].map(caseId => ({
      model: pair.model,
      variant: pair.variant ?? '',
      caseId,
      routeKey: ROUTE_A,
    }))
  );
}

/** A fixed shuffle: reverse, then rotate by three, so no list is in key order. */
function shuffled<T>(rows: readonly T[]): T[] {
  const out = [...rows].reverse();
  const shift = out.length === 0 ? 0 : 3 % out.length;
  return [...out.slice(shift), ...out.slice(0, shift)];
}

/**
 * Insert the fixture into the migrated SQLite database, in a fixed shuffled order
 * so no table is in primary-key order as stored. The deployed readers have no
 * ORDER BY, so their scans see primary-key order; the test asserts the current
 * assembly produces the same bytes regardless.
 */
export function seedCustomTableFixture(sqlite: DatabaseSync): void {
  const profile = sqlite.prepare(
    `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
      status, run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
     VALUES ('efficient', ?, ?, ?, 3, 'ready', ?, '2026-11-01', '2026-11-01', '2026-11-01', 0, 1)`
  );
  for (const row of shuffled(profileRows())) {
    profile.run(row.model, row.variant, FIXTURE_ENGINE, FIXTURE_RUN_ID);
  }

  const summary = sqlite.prepare(
    `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
      avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
     VALUES (?, ?, ?, ?, ?, 0.001, 800, 800, 20, 0, 900, 0)`
  );
  for (const row of shuffled(fixtureSummaries())) {
    summary.run(FIXTURE_RUN_ID, row.model, row.variant ?? '', row.routeKey, row.accuracy);
  }

  const graded = sqlite.prepare(
    `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
      cost_usd, rep)
     VALUES (?, ?, ?, ?, ?, 0.9, 100, 0.001, 0)`
  );
  for (const row of shuffled(caseRows())) {
    graded.run(FIXTURE_RUN_ID, row.model, row.variant, row.caseId, row.routeKey);
  }
}

/** The published document without its build timestamp. */
export function withoutGeneratedAt(table: unknown): unknown {
  const { generatedAt: _generatedAt, ...rest } = table as Record<string, unknown>;
  return rest;
}
