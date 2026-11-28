import type { BundleBinding } from '@kilocode/secrets-client';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./sync.js', () => ({
  createPromotionStore: vi.fn(),
  syncPromotionsFromBench: vi.fn(),
}));

const SELECTED = 'internal-secret';
const SYNC_RESULT = { fetched: 0, inserted: 0, alreadyHad: 0, cacheRecomputes: 0 };

function okBundle(value: string) {
  return {
    status: 'ok' as const,
    workload: 'model-eval-ingest',
    environment: 'production' as const,
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-28T00:00:00.000Z',
    secrets: { INTERNAL_API_SECRET: { value, version: 1 } },
    missing: [],
  };
}

/** The production render with fixture bindings: comparison on, legacy source serving. */
function productionEnv(stsCopy: string, legacy = SELECTED) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => okBundle(stsCopy));
  const legacyGet = vi.fn(async () => legacy);
  const env = {
    ENVIRONMENT: 'production',
    SECRETS_SOURCE: 'secrets-store',
    SECRETS_COMPARE_ENABLED: 'true',
    HYPERDRIVE: { connectionString: 'postgres://test' },
    BENCH_DASHBOARD: {},
    INTERNAL_API_SECRET: { get: legacyGet },
    STS: { getBundle },
  } as unknown as CloudflareEnv;
  return { env, getBundle, legacyGet };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    }),
    passThroughOnException: vi.fn(),
  };
  return { ctx, settled: () => Promise.all(pending) };
}

function syncRequest(key?: string) {
  return new Request('https://model-eval-ingest/internal/sync', {
    method: 'POST',
    headers: key === undefined ? {} : { 'x-internal-api-key': key },
  });
}

/**
 * A fresh module graph per test, imported dynamically on purpose: the comparison latches once per
 * isolate, so each test needs its own module instance. The mocks come from the same graph.
 */
async function freshWorker() {
  vi.resetModules();
  const { getWorkerDb } = await import('@kilocode/db/client');
  const sync = await import('./sync.js');
  const { default: worker } = await import('./index.js');
  vi.mocked(getWorkerDb).mockReturnValue({} as never);
  vi.mocked(sync.syncPromotionsFromBench).mockResolvedValue(SYNC_RESULT);
  return { worker, syncPromotionsFromBench: sync.syncPromotionsFromBench };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** The comparison's own lines; an accepted key also writes the internal-auth counter line. */
function compareLines(log: MockInstance<typeof console.log>) {
  return log.mock.calls.filter(
    ([event]) => typeof event === 'string' && event.startsWith('model_eval_ingest_secrets_compare')
  );
}

describe('sync route source comparison', () => {
  it('answers an accepted key as before and compares once per isolate in the background', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { worker } = await freshWorker();
    const { env, getBundle } = productionEnv(SELECTED);
    const { ctx, settled } = executionContext();

    const first = await worker.fetch(syncRequest(SELECTED), env, ctx);
    const second = await worker.fetch(syncRequest(SELECTED), env, ctx);
    await settled();

    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, ...SYNC_RESULT });
    }
    expect(getBundle).toHaveBeenCalledOnce();
    expect(compareLines(log)).toEqual([
      [
        'model_eval_ingest_secrets_compare',
        { route: 'sync', secret: 'INTERNAL_API_SECRET', source: 'secrets-store', result: 'match' },
      ],
    ]);
  });

  it('refuses a wrong key with the same 401, starts no comparison and keeps the latch armed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { worker, syncPromotionsFromBench } = await freshWorker();
    const { env, getBundle } = productionEnv(SELECTED);
    const { ctx, settled } = executionContext();

    const refused = await worker.fetch(syncRequest('wrong-key'), env, ctx);

    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Unauthorized' });
    expect(syncPromotionsFromBench).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(compareLines(log)).toEqual([]);

    // The refusal consumed nothing: the first accepted key in this isolate still compares.
    const accepted = await worker.fetch(syncRequest(SELECTED), env, ctx);
    await settled();

    expect(accepted.status).toBe(200);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(compareLines(log)).toEqual([
      [
        'model_eval_ingest_secrets_compare',
        { route: 'sync', secret: 'INTERNAL_API_SECRET', source: 'secrets-store', result: 'match' },
      ],
    ]);
  });

  it('serves an accepted key as before when waitUntil refuses, with no read and the latch armed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { worker } = await freshWorker();
    const { env, getBundle } = productionEnv(SELECTED);
    const refusing = {
      waitUntil: vi.fn(() => {
        throw new Error('waitUntil refused');
      }),
      passThroughOnException: vi.fn(),
    };

    const served = await worker.fetch(syncRequest(SELECTED), env, refusing);

    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ success: true, ...SYNC_RESULT });
    expect(refusing.waitUntil).toHaveBeenCalledOnce();
    expect(getBundle).not.toHaveBeenCalled();
    expect(compareLines(log)).toEqual([]);

    const { ctx, settled } = executionContext();
    const accepted = await worker.fetch(syncRequest(SELECTED), env, ctx);
    await settled();

    expect(accepted.status).toBe(200);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(compareLines(log)).toEqual([
      [
        'model_eval_ingest_secrets_compare',
        { route: 'sync', secret: 'INTERNAL_API_SECRET', source: 'secrets-store', result: 'match' },
      ],
    ]);
  });

  it('refuses a key against an empty legacy value as before, with no comparison', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { worker } = await freshWorker();
    const { env, getBundle } = productionEnv(SELECTED, '');
    const { ctx } = executionContext();

    const response = await worker.fetch(syncRequest('any-key'), env, ctx);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(getBundle).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(compareLines(log)).toEqual([]);
  });

  it('refuses a keyless request before any secret read or comparison', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { worker } = await freshWorker();
    const { env, getBundle, legacyGet } = productionEnv(SELECTED);
    const { ctx } = executionContext();

    const response = await worker.fetch(syncRequest(), env, ctx);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(legacyGet).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(compareLines(log)).toEqual([]);
  });

  it('starts nothing in the dev render, which sets neither the flag nor STS', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { worker } = await freshWorker();
    const env = {
      ENVIRONMENT: 'development',
      HYPERDRIVE: { connectionString: 'postgres://test' },
      BENCH_DASHBOARD: {},
      INTERNAL_API_SECRET: { get: async () => SELECTED },
    } as unknown as CloudflareEnv;
    const { ctx } = executionContext();

    const accepted = await worker.fetch(syncRequest(SELECTED), env, ctx);
    const refused = await worker.fetch(syncRequest('wrong-key'), env, ctx);

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(compareLines(log)).toEqual([]);
  });
});
