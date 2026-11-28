import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
  type MintRequest,
  type MintResult,
} from '@kilocode/sts-contracts';
import {
  fetchClassifierWinnerFromOrigin,
  fetchCustomRouterEpoch,
  fetchRoutingTableFromOrigin,
  forwardClientEval,
} from './benchmark-origin';
import type * as SecretsModule from './secrets';
import type { AutoRoutingSecretName, AutoRoutingSecretsEnv } from './secrets';

/**
 * The eval routes are the one place this Worker forwards a client request to the benchmark Worker
 * with an invocation context in hand. Proving the context reaches the secret read keeps
 * `fetchBenchmark`'s trailing parameter load-bearing: a bundle revalidation the read abandons is
 * handed to that invocation's `waitUntil` (packages/secrets-client/src/client.ts `currentBundle`).
 */
const readSecret = vi.hoisted(() => vi.fn());

vi.mock('./secrets', async importOriginal => {
  const actual = await importOriginal<typeof SecretsModule>();
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
  const secret = { get: async () => 'legacy-internal' };
  return {
    env: {
      BENCHMARK_SERVICE: { fetch } as unknown as Fetcher,
      INTERNAL_API_SECRET_PROD: secret,
    },
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

/** A fake `STS` binding: it issues a fresh token per mint, or answers `answer`. */
function stsBinding(answer?: () => MintResult) {
  let minted = 0;
  return {
    mintTokens: vi.fn(async (request: MintRequest): Promise<MintResult> => {
      if (answer) return answer();
      minted += 1;
      return {
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }) => ({
          status: 'issued' as const,
          audience,
          scope,
          token: `minted-token-${minted}`,
          jti: `jti-${minted}`,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        })),
      };
    }),
  };
}

function routingTablesEnv(auth: string | undefined, sts = stsBinding()) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ table: null, publishedAt: null, winner: null, epoch: 3 })
  );
  return {
    env: {
      BENCHMARK_SERVICE: { fetch } as unknown as Fetcher,
      INTERNAL_API_SECRET_PROD: { get: async () => 'legacy-internal' },
      BENCHMARK_ROUTING_TABLES_SENDER_AUTH: auth,
      STS: sts,
    },
    fetch,
    sts,
  };
}

function sentAuthorization(fetch: ReturnType<typeof routingTablesEnv>['fetch'], index = 0) {
  return new Headers(fetch.mock.calls[index]?.[1]?.headers).get('authorization');
}

describe('routing-table reads over BENCHMARK_SERVICE', () => {
  beforeEach(() => {
    readSecret.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([undefined, '', 'legacy'])(
    'sends the internal secret and mints nothing while the switch is %j',
    async auth => {
      const { env, fetch, sts } = routingTablesEnv(auth);
      await fetchRoutingTableFromOrigin(env);

      expect(sts.mintTokens).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe('https://auto-routing-benchmark/admin/routing-table');
      expect(sentAuthorization(fetch)).toBe('Bearer legacy-internal');
    }
  );

  it('sends exactly one routing-tables.read token, and no secret, under sts', async () => {
    const { env, fetch, sts } = routingTablesEnv('sts');
    await fetchRoutingTableFromOrigin(env);

    expect(sts.mintTokens).toHaveBeenCalledTimes(1);
    expect(sts.mintTokens).toHaveBeenCalledWith({
      tokens: [STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentAuthorization(fetch)).toBe('Bearer minted-token-1');
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('holds the token across reads: two reads, one mint', async () => {
    const { env, fetch, sts } = routingTablesEnv('sts');
    await fetchRoutingTableFromOrigin(env);
    await fetchClassifierWinnerFromOrigin(env);

    expect(sts.mintTokens).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentAuthorization(fetch, 1)).toBe('Bearer minted-token-1');
  });

  it.each(['STS', 'dual', 'true'])('sends nothing for the switch value %j', async auth => {
    const { env, fetch, sts } = routingTablesEnv(auth);

    await expect(fetchRoutingTableFromOrigin(env)).rejects.toThrow('auth_misconfigured');
    expect(fetch).not.toHaveBeenCalled();
    expect(sts.mintTokens).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('fails the read, and never sends the secret, when STS refuses the token', async () => {
    const denied = stsBinding(() => ({
      status: 'ok',
      tokens: [
        {
          status: 'denied',
          ...STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
          reason: 'unknown_scope',
        },
      ],
    }));
    const { env, fetch } = routingTablesEnv('sts', denied);

    await expect(fetchRoutingTableFromOrigin(env)).rejects.toThrow('token_denied');
    // The epoch probe answers "unproven" rather than throw, still without a request.
    await expect(fetchCustomRouterEpoch(env, 'efficient')).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('keeps the internal secret on the client eval forward under sts', async () => {
    const { env, fetch, sts } = routingTablesEnv('sts');
    await forwardClientEval(env, '/v1/eval/plan', { routerId: 'r' });

    expect(sts.mintTokens).not.toHaveBeenCalled();
    expect(sentAuthorization(fetch)).toBe('Bearer legacy-internal');
  });
});
