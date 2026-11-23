import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BenchmarkConfig,
  CustomRouterBenchmarkContext,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { assembleCustomRouterTable } from './custom-routers';
import { computeEngineIdentity } from './run';

const CONFIG: BenchmarkConfig = {
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

const ENGINE = computeEngineIdentity('decider', 'efficient');
const ROUTE = 'implementation/code_generation';
const ROUTE_B = 'planning_design/technical_planning';
const RUN = 'run-tied';

// Six cases per complexity bucket, so `buildEffortByComplexity` decides a variant.
const LOW_CASES = [
  'impl-feat-ternary-parity',
  'impl-feat-array-pipeline',
  'impl-feat-closure-counter',
  'impl-feat-recursion-fib',
  'impl-feat-this-binding',
  'impl-gen-package-manifest',
];
const HIGH_CASES = [
  'invest-code-v2-queue-rejection-propagation',
  'invest-ext-v2-quota-reserved-costs',
  'invest-ext-v2-durability-ack-levels',
  'invest-ext-v2-delivery-guarantee-scope',
  'invest-ext-v2-benchmark-confounding-sources',
  'plan-steps-v2-expand-contract-sequence',
];

const catalog: typeof fetch = async () =>
  Response.json({
    data: [
      { id: 'vendor/aaa', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'vendor/zzz', pricing: { prompt: '0.000001', completion: '0.000002' } },
      {
        id: 'vendor/variants',
        opencode: {
          // The catalog lists the same order the pair key sorts to: high, then low.
          variants: {
            high: { reasoning: { enabled: true, effort: 'high' } },
            low: { reasoning: { enabled: true, effort: 'low' } },
          },
        },
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
    ],
  });

const source = {
  catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
  fetchImpl: catalog,
  now: new Date('2026-11-22T00:00:00.000Z'),
};

function seedProfile(sqlite: DatabaseSync, model: string, variant: string) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
        status, run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
       VALUES ('efficient', ?, ?, ?, 3, 'ready', ?, '2026-11-01', '2026-11-01', '2026-11-01', 0, 1)`
    )
    .run(model, variant, ENGINE, RUN);
}

function seedSummary(
  sqlite: DatabaseSync,
  model: string,
  variant: string,
  routeKey: string,
  accuracy: number
) {
  sqlite
    .prepare(
      `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
        avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
       VALUES (?, ?, ?, ?, ?, 0.001, 800, 800, 20, 0, 900, 0)`
    )
    .run(RUN, model, variant, routeKey, accuracy);
}

function seedCases(sqlite: DatabaseSync, model: string, variant: string) {
  const insert = sqlite.prepare(
    `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
      cost_usd, rep)
     VALUES (?, ?, ?, ?, ?, 0.9, 100, 0.001, 0)`
  );
  for (const caseId of LOW_CASES) insert.run(RUN, model, variant, caseId, ROUTE);
  for (const caseId of HIGH_CASES) insert.run(RUN, model, variant, caseId, ROUTE);
}

describe('custom router order parity (real migrated SQLite)', () => {
  let db: D1Database;

  beforeEach(() => {
    const sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    // Two models that tie exactly on every ranking key, plus one model whose two variants tie.
    for (const model of ['vendor/aaa', 'vendor/zzz']) {
      seedProfile(sqlite, model, '');
      seedSummary(sqlite, model, '', ROUTE, 0.9);
      seedSummary(sqlite, model, '', ROUTE_B, 0.9);
    }
    for (const variant of ['high', 'low']) {
      seedProfile(sqlite, 'vendor/variants', variant);
      seedSummary(sqlite, 'vendor/variants', variant, ROUTE, 0.9);
      seedSummary(sqlite, 'vendor/variants', variant, ROUTE_B, 0.9);
      seedCases(sqlite, 'vendor/variants', variant);
    }
  });

  const context = (entries: string[]): CustomRouterBenchmarkContext => ({
    ownerType: 'user',
    ownerId: 'user-1',
    baseRouter: 'efficient',
    entries: entries.map(model => ({ kind: 'gateway', model })),
    clientEvalEntryKeys: [],
  });

  const entries = ['vendor/zzz', 'vendor/aaa', 'vendor/variants'];

  it('gives a pool and its reversed entry order byte-identical tables and versions', async () => {
    const forward = await assembleCustomRouterTable(db, CONFIG, context(entries), source);
    const reversed = await assembleCustomRouterTable(
      db,
      CONFIG,
      context([...entries].reverse()),
      source
    );
    expect(reversed.table).not.toBeNull();
    expect(reversed.table?.version).toBe(forward.table?.version);
    expect(JSON.stringify(reversed.table)).toBe(JSON.stringify(forward.table));
  });

  it('keeps the database row order the deployed table published, not the pool order', async () => {
    const { table } = await assembleCustomRouterTable(
      db,
      CONFIG,
      context([...entries].reverse()),
      source
    );
    // model_summaries primary key order: run, model, variant, route.
    expect(table?.routes[ROUTE]?.map(candidate => candidate.model)).toEqual([
      'vendor/aaa',
      'vendor/variants',
      'vendor/variants',
      'vendor/zzz',
    ]);
    expect(table?.routes[ROUTE]?.map(candidate => candidate.variant ?? null)).toEqual([
      null,
      'high',
      'low',
      null,
    ]);
    // Both variants tie on every ranking key, so the pair key decides: 'high' sorts first.
    expect(table?.effortByComplexity?.[ROUTE]?.['vendor/variants']).toEqual({
      low: 'high',
      medium: 'high',
      high: 'high',
    });
  });

  it('re-emits the same table for every permutation of the pool entries', async () => {
    const permutations = [
      ['vendor/aaa', 'vendor/variants', 'vendor/zzz'],
      ['vendor/aaa', 'vendor/zzz', 'vendor/variants'],
      ['vendor/variants', 'vendor/aaa', 'vendor/zzz'],
      ['vendor/variants', 'vendor/zzz', 'vendor/aaa'],
      ['vendor/zzz', 'vendor/aaa', 'vendor/variants'],
      ['vendor/zzz', 'vendor/variants', 'vendor/aaa'],
    ];
    const tables = await Promise.all(
      permutations.map(order => assembleCustomRouterTable(db, CONFIG, context(order), source))
    );
    expect(tables[0]!.table).not.toBeNull();
    const baseline = JSON.stringify(tables[0]!.table);
    for (const { table } of tables) {
      expect(JSON.stringify(table)).toBe(baseline);
    }
  });
});
