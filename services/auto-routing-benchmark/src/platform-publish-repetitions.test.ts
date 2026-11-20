import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TAXONOMY_ROUTE_KEYS, type AutoRouter } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { getLatestRoutingTable, replaceConfig } from './db';
import { computeEngineIdentity, publishPlatformRoutingTable } from './run';

const ROUTE = TAXONOMY_ROUTE_KEYS[0];
const MEASURED_THREE_TIMES = 'vendor/measured-three-times';
const MEASURED_ONCE = 'vendor/measured-once';

const catalogFetch = vi.fn<typeof fetch>(async () =>
  Response.json({
    data: [
      { id: MEASURED_THREE_TIMES, pricing: { prompt: '0.000003', completion: '0.000006' } },
      { id: MEASURED_ONCE, pricing: { prompt: '0.000001', completion: '0.000002' } },
    ],
  })
);

describe('platform publish under router decider repetitions (migrated SQLite)', () => {
  let sqlite: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    env = {
      BENCH_DB: sqliteD1(sqlite),
      AUTO_ROUTING_CONFIG: { delete: vi.fn() },
      KILO_WEB_API_BASE_URL: 'https://app.test',
    } as unknown as Env;
  });

  async function seed(router: AutoRouter) {
    const models = [MEASURED_THREE_TIMES, MEASURED_ONCE];
    await replaceConfig(
      env.BENCH_DB,
      {
        min_accuracy: 0.7,
        benchmark_user_id: null,
        benchmark_org_id: null,
        updated_at: '2026-10-01T00:00:00.000Z',
        updated_by: null,
      },
      ['classifier/a'],
      models.map(model => ({ model, variant: null, reasoning_effort: null })),
      router
    );
    const entries = models.map(model => ({
      model,
      pairs: [{ model, variant: null }],
      servingPairs: [],
      resolutionError: null,
    }));
    sqlite
      .prepare(
        `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
         VALUES (?, 'platform', '', 'rev-1', ?, '2026-10-01')`
      )
      .run(router, JSON.stringify({ entries, previousEntries: [] }));
    const engine = computeEngineIdentity('decider', router);
    for (const [model, repetitions, accuracy] of [
      [MEASURED_THREE_TIMES, 3, 0.9],
      [MEASURED_ONCE, 1, 0.95],
    ] as const) {
      const runId = `run-${model}`;
      sqlite
        .prepare(
          `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
            run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
           VALUES (?, ?, '', ?, ?, 'ready', ?, '2026-10-01', '2026-10-01', '2026-10-01', 1, 0)`
        )
        .run(router, model, engine, repetitions, runId);
      const summary = sqlite.prepare(
        `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
          avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
         VALUES (?, ?, '', ?, ?, 0.001, 800, 800, 30, 0, 900, 0)`
      );
      for (const routeKey of TAXONOMY_ROUTE_KEYS) summary.run(runId, model, routeKey, accuracy);
    }
  }

  async function servedModels(router: AutoRouter) {
    await expect(publishPlatformRoutingTable(env, catalogFetch, router)).resolves.not.toBeNull();
    const published = await getLatestRoutingTable(env.BENCH_DB, router);
    return (published?.table.routes[ROUTE] ?? []).map(candidate => candidate.model);
  }

  it('serves only the efficient profile measured three times', async () => {
    await seed('efficient');
    expect(await servedModels('efficient')).toEqual([MEASURED_THREE_TIMES]);
  });

  it('serves only the frontier profile measured once', async () => {
    await seed('frontier');
    expect(await servedModels('frontier')).toEqual([MEASURED_ONCE]);
  });
});
