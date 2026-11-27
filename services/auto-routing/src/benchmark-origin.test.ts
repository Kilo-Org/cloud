import { describe, expect, it, vi } from 'vitest';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { forwardClientEval } from './benchmark-origin';
import type { AutoRoutingSecretName, AutoRoutingSecretsEnv } from './secrets';

/**
 * The eval routes are the one place this Worker forwards a client request to the benchmark Worker
 * with an invocation context in hand. Proving the context reaches the secret read keeps
 * `fetchBenchmark`'s trailing parameter load-bearing: a bundle revalidation the read abandons is
 * handed to that invocation's `waitUntil` (packages/secrets-client/src/client.ts `currentBundle`).
 */
const readSecret = vi.hoisted(() => vi.fn());

vi.mock('./secrets', async importOriginal => {
  const actual = await importOriginal<typeof import('./secrets')>();
  return {
    ...actual,
    readAutoRoutingSecret: async (
      env: AutoRoutingSecretsEnv,
      name: AutoRoutingSecretName,
      ctx?: SecretsExecutionContext
    ): Promise<string> => {
      readSecret(env, name, ctx);
      return actual.readAutoRoutingSecret(env, name, ctx);
    },
  };
});

function benchmarkEnv() {
  const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  return {
    env: { BENCHMARK_SERVICE: { fetch }, INTERNAL_API_SECRET_PROD: 'legacy-internal' },
    fetch,
  };
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('forwardClientEval', () => {
  it('passes the invocation context into the internal-authentication read', async () => {
    const { env, fetch } = benchmarkEnv();
    const res = await forwardClientEval(env, '/v1/eval/plan', { routerId: 'r' }, executionCtx);

    expect(res.status).toBe(200);
    expect(readSecret).toHaveBeenCalledWith(env, 'INTERNAL_API_SECRET', executionCtx);
    expect(fetch).toHaveBeenCalledWith(
      'https://auto-routing-benchmark/v1/eval/plan',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer legacy-internal',
          'content-type': 'application/json',
        },
      })
    );
  });

  it('reads with no context when the caller holds none', async () => {
    const { env } = benchmarkEnv();
    await forwardClientEval(env, '/v1/eval/plan', { routerId: 'r' });

    expect(readSecret).toHaveBeenCalledWith(env, 'INTERNAL_API_SECRET', undefined);
  });
});
