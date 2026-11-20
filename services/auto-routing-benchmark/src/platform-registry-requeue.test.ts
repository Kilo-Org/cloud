import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutoRouter } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { replaceConfig } from './db';
import { computeEngineIdentity, syncPlatformRegistry } from './run';

const PAIR = 'vendor/astra';
const RETRY_DUE = '2026-11-20T00:00:00.000Z';
const RETRY_LATER = '2099-01-01T00:00:00.000Z';

const catalogFetch = vi.fn<typeof fetch>(async input => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url.includes('/bot-token'))
    return Response.json({
      token: 'e2e-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  return Response.json({
    data: [
      { id: '~vendor/astra-latest', alias_target: PAIR },
      { id: PAIR, pricing: { prompt: '0.000001', completion: '0.000002' } },
    ],
  });
});

describe('syncPlatformRegistry — a settled platform failure cannot freeze the table', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let router: AutoRouter;
  let engine: string;

  beforeEach(() => {
    catalogFetch.mockClear();
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    env = {
      BENCH_DB: sqliteD1(sqlite),
      AUTO_ROUTING_CONFIG: { delete: vi.fn(), put: vi.fn(), get: vi.fn() },
      BOT_TOKEN_MINT_SECRET: { get: async () => 'mint-secret' },
      KILO_WEB_API_BASE_URL: 'https://app.test',
      KILO_CLI_API_URL: 'https://app.test',
    } as unknown as Env;
    router = 'frontier';
    engine = computeEngineIdentity('decider', router);
  });

  async function seedPlatformPair(status: 'failed' | 'unavailable', retryAfter: string | null) {
    await replaceConfig(
      env.BENCH_DB,
      {
        min_accuracy: 0.7,
        benchmark_user_id: null,
        benchmark_org_id: null,
        updated_at: '2026-11-20',
        updated_by: null,
      },
      ['classifier/a'],
      [{ model: '~vendor/astra-latest', variant: null, reasoning_effort: null }],
      router
    );
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, completed_at, platform_requested, user_requested,
          failure_class, failure_reason, retry_after)
         VALUES (?, ?, '', ?, 1, ?, NULL, '2026-11-20', '2026-11-20', '2026-11-20', 1, 0,
           'provider_unavailable', 'Provider returned 503', ?)`
      )
      .run(router, PAIR, engine, status, retryAfter);
  }

  function profileStatus() {
    return sqlite
      .prepare('SELECT status, retry_after FROM benchmark_profiles WHERE model = ?')
      .get(PAIR);
  }

  it('requeues a failed platform pair whose retry window has passed', async () => {
    await seedPlatformPair('failed', RETRY_DUE);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await syncPlatformRegistry(env, catalogFetch, router);
    const requeued = log.mock.calls
      .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .filter(entry => entry.event === 'benchmark_platform_retry_requeued');
    log.mockRestore();

    expect(requeued).toEqual([{ event: 'benchmark_platform_retry_requeued', router, requeued: 1 }]);
    expect(profileStatus()).toEqual({ status: 'pending', retry_after: null });
  });

  it('leaves a failed pair alone until its retry window passes', async () => {
    await seedPlatformPair('failed', RETRY_LATER);
    await syncPlatformRegistry(env, catalogFetch, router);
    expect(profileStatus()).toEqual({ status: 'failed', retry_after: RETRY_LATER });
  });

  it('leaves a permanently unavailable pair for an operator', async () => {
    await seedPlatformPair('unavailable', null);
    await syncPlatformRegistry(env, catalogFetch, router);
    expect(profileStatus()).toEqual({ status: 'unavailable', retry_after: null });
  });
});
