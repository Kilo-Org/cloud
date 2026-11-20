import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BenchmarkConfig,
  ClientCustomRouterEntry,
  CustomRouterBenchmarkContext,
  CustomRoutingTable,
  TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import type * as MeasurementRevision from './measurement-revision';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { DECIDER_CASES } from './datasets/decider-cases';
import { PROBE_ROUTE_KEYS } from './probe/eligibility';
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
const OTHER_ROUTE = 'implementation/code_generation';
const LOCAL = 'client:ollama/qwen3:32b';
const GATEWAY = 'vendor/gw';

const localModel: ClientCustomRouterEntry = {
  kind: 'client',
  provider: 'ollama',
  model: 'qwen3:32b',
  variants: ['low'],
  capabilities: {
    contextLength: 32_768,
    inputModalities: ['text'],
    toolCall: true,
    reasoning: true,
  },
  pricing: null,
};

const clientOnly: CustomRouterBenchmarkContext = {
  ownerType: 'user',
  ownerId: 'user-1',
  baseRouter: 'efficient',
  entries: [localModel],
  clientEvalEntryKeys: [LOCAL],
};

const withGateway: CustomRouterBenchmarkContext = {
  ...clientOnly,
  entries: [localModel, { kind: 'gateway', model: GATEWAY }],
};

const source = {
  catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
  fetchImpl: (async () =>
    Response.json({
      data: [{ id: GATEWAY, pricing: { prompt: '0.000001', completion: '0.000002' } }],
    })) as typeof fetch,
  now: new Date('2026-10-16T12:00:00.000Z'),
};

const ALL_ROUTES: TaxonomyRouteKey[] = [...PROBE_ROUTE_KEYS, OTHER_ROUTE];

function summary(routeKey: string, model = LOCAL, variant: string | null = 'low') {
  return {
    model,
    variant,
    routeKey,
    accuracy: 0.9,
    avgCostUsd: 0,
    avgLatencyMs: 900,
    p50LatencyMs: 900,
    p95LatencyMs: 1200,
    cases: 20,
    errors: 0,
    timeouts: 0,
    routeAccuracy: null,
  };
}

const routes = (table: CustomRoutingTable | null) => Object.keys(table?.routes ?? {}).sort();

const candidates = (table: CustomRoutingTable | null, routeKey: TaxonomyRouteKey) =>
  (table?.routes[routeKey] ?? []).map(candidate => candidate.model).sort();

/** Assembles the table of the given context with the given active revision. */
async function assemble(
  db: D1Database,
  activeRevision: number,
  context: CustomRouterBenchmarkContext = clientOnly
) {
  vi.resetModules();
  // The activation constant is read when the table is assembled, so the revision under test
  // must be mocked before the module graph loads: a static import would freeze it at 2.
  vi.doMock('./measurement-revision', async importOriginal => {
    const actual = await importOriginal<typeof MeasurementRevision>();
    return { ...actual, ACTIVE_MEASUREMENT_REVISION: activeRevision };
  });
  const { assembleCustomRouterTable } = await import('./custom-routers');
  return assembleCustomRouterTable(db, CONFIG, context, source);
}

describe('client-uploaded measurements under probe activation (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO client_profiles (id, owner_type, owner_id, router, entry_kind, provider, model,
          variant, engine_identity, repetitions, status, results, accuracy, route_summaries,
          created_at, updated_at)
         VALUES ('current', 'user', 'user-1', 'efficient', 'client', 'ollama', 'qwen3:32b',
           'low', ?, 3, 'ready', ?, 0.9, ?, '2026-10-10', '2026-10-10')`
      )
      .run(
        ENGINE,
        DECIDER_CASES.length * 3,
        JSON.stringify(ALL_ROUTES.map(routeKey => summary(routeKey)))
      );
  });

  /** A ready platform pair of the current engine whose run has no probe results. */
  function platformPair(runId: string) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES ('efficient', ?, '', ?, 3, 'ready', ?, '2026-10-01', '2026-10-01', '2026-10-01', 0, 1)`
      )
      .run(GATEWAY, ENGINE, runId);
    for (const routeKey of ALL_ROUTES) {
      sqlite
        .prepare(
          `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
            avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
           VALUES (?, ?, '', ?, 0.95, 0.001, 800, 800, 20, 0, 900, 0)`
        )
        .run(runId, GATEWAY, routeKey);
    }
  }

  it('keeps every agentic route a client upload reports while a platform pair without probe results loses them', async () => {
    platformPair('platform-run');
    const { table } = await assemble(db, 3, withGateway);
    expect(routes(table)).toEqual(ALL_ROUTES.slice().sort());
    for (const routeKey of PROBE_ROUTE_KEYS) {
      expect(candidates(table, routeKey)).toEqual([LOCAL]);
    }
    expect(candidates(table, OTHER_ROUTE)).toEqual([LOCAL, GATEWAY]);
  });

  it('keeps a platform pair on every route before the probe revision activates', async () => {
    platformPair('platform-run');
    const { table } = await assemble(db, 2, withGateway);
    for (const routeKey of PROBE_ROUTE_KEYS) {
      expect(candidates(table, routeKey)).toEqual([LOCAL, GATEWAY]);
    }
  });
});
