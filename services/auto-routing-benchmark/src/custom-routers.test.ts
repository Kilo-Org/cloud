import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BenchmarkConfig,
  ClientCustomRouterEntry,
  CustomRouterBenchmarkContext,
  CustomRoutingTable,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { assembleCustomRouterTable, lookupCustomRouterStatuses } from './custom-routers';
import { DECIDER_CASES } from './datasets/decider-cases';
import { computeEngineIdentity } from './run';

const CONFIG: BenchmarkConfig = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  frontierMinAccuracyDelta: 0,
  classifierModels: ['typesafe/jev-1.13'],
  deciderModels: [{ id: 'vendor/platform' }],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  lowConfidenceThreshold: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: 1000,
  updatedAt: null,
  updatedBy: null,
};

const ENGINE = computeEngineIdentity('decider', 'efficient');
const OLD_ENGINE = 'efficient:v0:old';
const ROUTE = 'implementation/code_generation';
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

const catalogFetch: typeof fetch = async () =>
  Response.json({
    data: [{ id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } }],
  });

const withGateway: CustomRouterBenchmarkContext = {
  ...clientOnly,
  entries: [localModel, { kind: 'gateway', model: 'vendor/gw' }],
};

const source = {
  catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
  fetchImpl: catalogFetch,
  now: new Date('2026-10-16T12:00:00.000Z'),
};

function summary(model: string, variant: string | null, accuracy: number) {
  return {
    model,
    variant,
    routeKey: ROUTE,
    accuracy,
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

describe('custom router tables and statuses (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  function clientProfile(row: {
    id: string;
    engine?: string;
    accuracy: number;
    updatedAt: string;
    ownerId?: string;
    variant?: string;
    status?: 'pending' | 'ready' | 'failed';
    results?: number;
  }) {
    sqlite
      .prepare(
        `INSERT INTO client_profiles (id, owner_type, owner_id, router, entry_kind, provider, model,
          variant, engine_identity, repetitions, status, results, accuracy, route_summaries,
          created_at, updated_at)
         VALUES (?, 'user', ?, 'efficient', 'client', 'ollama', 'qwen3:32b', ?, ?, 1, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.ownerId ?? 'user-1',
        row.variant ?? 'low',
        row.engine ?? ENGINE,
        row.status ?? 'ready',
        row.results ?? DECIDER_CASES.length,
        row.accuracy,
        JSON.stringify([summary(LOCAL, row.variant ?? 'low', row.accuracy)]),
        row.updatedAt,
        row.updatedAt
      );
  }

  function platformProfile(row: {
    engine: string;
    status: 'pending' | 'ready';
    runId: string | null;
    accuracy?: number;
  }) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', '', ?, 1, ?, ?, '2026-10-01', '2026-10-01', '2026-10-01', 0, 1)`
      )
      .run(row.engine, row.status, row.runId);
    if (row.runId && row.accuracy !== undefined) {
      sqlite
        .prepare(
          `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
            avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
           VALUES (?, 'vendor/gw', '', ?, ?, 0.001, 800, 800, 20, 0, 900, 0)`
        )
        .run(row.runId, ROUTE, row.accuracy);
    }
  }

  const candidates = (table: CustomRoutingTable | null) =>
    (table?.routes[ROUTE] ?? []).map(c => ({
      model: c.model,
      variant: c.variant,
      accuracy: c.accuracy,
      stale: c.stale ?? false,
      estimatedRequestCostUsd: c.estimatedRequestCostUsd,
    }));

  it('emits a current client measurement as a $0 client candidate', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-10' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([
      { model: LOCAL, variant: 'low', accuracy: 0.9, stale: false, estimatedRequestCostUsd: 0 },
    ]);
  });

  it('serves an older-engine measurement flagged stale', async () => {
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-01' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.8, stale: true })]);
  });

  it('prefers the current measurement over a more recently updated older one', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-01' });
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-09' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.9, stale: false })]);
  });

  it('keeps serving a complete stale measurement while the current one is partial', async () => {
    clientProfile({ id: 'partial', accuracy: 1, updatedAt: '2026-10-12', results: 3 });
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-01' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.8, stale: true })]);
    const status = await lookupCustomRouterStatuses(db, CONFIG, clientOnly, source);
    expect(status.entries[0]?.variants).toEqual([
      { variant: 'low', status: 'stale', failureReason: null },
    ]);
  });

  it('serves a partial current measurement when no stale one exists', async () => {
    clientProfile({ id: 'partial', accuracy: 1, updatedAt: '2026-10-12', results: 3 });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 1, stale: false })]);
  });

  it('uses the newest ready measurement among older engines', async () => {
    clientProfile({
      id: 'older',
      engine: 'efficient:v0:a',
      accuracy: 0.7,
      updatedAt: '2026-09-01',
    });
    clientProfile({
      id: 'newer',
      engine: 'efficient:v0:b',
      accuracy: 0.85,
      updatedAt: '2026-10-01',
    });
    clientProfile({
      id: 'current-pending',
      accuracy: 0,
      updatedAt: '2026-10-15',
      status: 'pending',
    });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.85, stale: true })]);
  });

  it('never serves another owner or an unlisted variant', async () => {
    clientProfile({ id: 'other', ownerId: 'user-2', accuracy: 0.9, updatedAt: '2026-10-10' });
    clientProfile({ id: 'max', variant: 'max', accuracy: 0.9, updatedAt: '2026-10-10' });
    expect(await assembleCustomRouterTable(db, CONFIG, clientOnly, source)).toEqual({
      table: null,
    });
  });

  it('serves a stale platform gateway measurement beside client candidates', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-10' });
    platformProfile({ engine: OLD_ENGINE, status: 'ready', runId: 'run-old', accuracy: 0.95 });
    platformProfile({ engine: ENGINE, status: 'pending', runId: null });
    const { table } = await assembleCustomRouterTable(db, CONFIG, withGateway, source);
    expect(candidates(table)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'vendor/gw', accuracy: 0.95, stale: true }),
        expect.objectContaining({ model: LOCAL, stale: false }),
      ])
    );
    expect(table?.version).toMatch(/^registry-/);
  });

  it('changes the table version with each upload to the served profile', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-10' });
    const before = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    sqlite.exec(`UPDATE client_profiles SET results = results + 1`);
    const after = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(after.table?.version).not.toBe(before.table?.version);
  });

  it('reports ready, stale and missing per variant and re-admits stale platform pairs', async () => {
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-01' });
    platformProfile({ engine: OLD_ENGINE, status: 'ready', runId: 'run-old', accuracy: 0.95 });
    const statuses = await lookupCustomRouterStatuses(
      db,
      CONFIG,
      {
        ...withGateway,
        entries: [{ ...localModel, variants: ['low', 'high'] }, withGateway.entries[1]!],
      },
      source
    );
    expect(statuses.entries).toEqual([
      {
        key: LOCAL,
        variants: [
          { variant: 'low', status: 'stale', failureReason: null },
          { variant: 'high', status: 'missing', failureReason: null },
        ],
      },
      {
        key: 'gateway:vendor/gw',
        variants: [{ variant: null, status: 'stale', failureReason: null }],
      },
    ]);
    expect(
      sqlite.prepare('SELECT status FROM benchmark_profiles WHERE engine_identity = ?').all(ENGINE)
    ).toEqual([{ status: 'pending' }]);
  });
});
