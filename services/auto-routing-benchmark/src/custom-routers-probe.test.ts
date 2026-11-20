import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BenchmarkConfig,
  ClientCustomRouterEntry,
  CustomRouterBenchmarkContext,
  CustomRoutingTable,
} from '@kilocode/auto-routing-contracts';
import type * as MeasurementRevision from './measurement-revision';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { DECIDER_CASES } from './datasets/decider-cases';
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
const AGENTIC_ROUTE = 'agentic_execution/tool_usage';
const OTHER_ROUTE = 'implementation/code_generation';
const LOCAL = 'client:ollama/qwen3:32b';

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

const source = {
  catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
  fetchImpl: async () => Response.json({ data: [] }),
  now: new Date('2026-10-16T12:00:00.000Z'),
};

function summary(routeKey: string) {
  return {
    model: LOCAL,
    variant: 'low',
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

/** Assembles the table of the owner's client entry with the given active revision. */
async function assemble(db: D1Database, activeRevision: number) {
  vi.resetModules();
  // The activation constant is read when the table is assembled, so the revision under test
  // must be mocked before the module graph loads: a static import would freeze it at 2.
  vi.doMock('./measurement-revision', async importOriginal => {
    const actual = await importOriginal<typeof MeasurementRevision>();
    return { ...actual, ACTIVE_MEASUREMENT_REVISION: activeRevision };
  });
  const { assembleCustomRouterTable } = await import('./custom-routers');
  return assembleCustomRouterTable(db, CONFIG, clientOnly, source);
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
        JSON.stringify([summary(AGENTIC_ROUTE), summary(OTHER_ROUTE)])
      );
  });

  it('drops an agentic route a client upload cannot have probed and keeps the rest', async () => {
    const { table } = await assemble(db, 3);
    expect(routes(table)).toEqual([OTHER_ROUTE]);
  });

  it('keeps every route before activation', async () => {
    const { table } = await assemble(db, 2);
    expect(routes(table)).toEqual([AGENTIC_ROUTE, OTHER_ROUTE].sort());
  });
});
