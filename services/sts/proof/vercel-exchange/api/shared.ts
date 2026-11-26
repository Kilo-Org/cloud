import { getCache } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import {
  boundedInteger,
  claimSample,
  exchangeInput,
  exchangeOnce,
  refusal,
  tokenTimes,
  type ClaimSample,
  type RateLimitHeaders,
} from '../lib/exchange.js';
import { DEFAULT_SETTINGS, SharedExchangedToken, type Exchange } from '../lib/shared-token.js';

/** Module scope lives as long as the instance, so it tells instances and cold starts apart. */
const instanceId = randomUUID();
let invocations = 0;

/**
 * The keys are SHA-256 already; the package's default key hash is 32 bits, which would let two
 * keys share an entry.
 */
const tokens = new SharedExchangedToken(
  getCache({ namespace: 'sts-proof', keyHashFunction: key => key })
);

/**
 * Which store `getCache()` reaches. Without a Runtime Cache it falls back to memory per instance,
 * which would make every instance exchange for itself and void the run.
 */
function cacheBackend(): 'request-context' | 'runtime-cache-endpoint' | 'in-memory' {
  const holder: unknown = Reflect.get(globalThis, Symbol.for('@vercel/request-context'));
  if (typeof holder === 'object' && holder !== null && 'get' in holder) {
    const context: unknown =
      typeof holder.get === 'function' ? Reflect.apply(holder.get, holder, []) : undefined;
    if (typeof context === 'object' && context !== null && 'cache' in context && context.cache) {
      return 'request-context';
    }
  }
  return process.env.RUNTIME_CACHE_ENDPOINT && process.env.RUNTIME_CACHE_HEADERS
    ? 'runtime-cache-endpoint'
    : 'in-memory';
}

/**
 * One STS-audience token per invocation through the D10 shared cache (`lib/shared-token.ts`), the
 * way the slice-4 client gets it. `drive.ts --mode shared` fans it out over a cold wave.
 * `?jitterMs=`, `?claim=0` and `?deadlineMs=` override the algorithm's defaults for a run; `?run=`
 * salts the cache and memory key (`keyPrefix`), so a run never reads an earlier run's token while
 * the audience stays the same.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused !== null) return refused;
  const input = exchangeInput(request);
  if (input instanceof Response) return input;

  invocations += 1;
  const url = new URL(request.url);
  const rateLimitHeaders: RateLimitHeaders[] = [];
  let exchangedClaims: ClaimSample | undefined;
  const exchange: Exchange = async (baseToken, audience) => {
    const result = await exchangeOnce({ baseToken, audience });
    if (result.rateLimitHeaders !== undefined) rateLimitHeaders.push(result.rateLimitHeaders);
    if (result.token !== undefined) {
      exchangedClaims = claimSample(result.token, baseToken);
      return { kind: 'token', token: result.token };
    }
    if (result.status === 429) return { kind: 'rate_limited' };
    return { kind: 'failed', detail: `exchange answered ${result.status}: ${result.errorBody}` };
  };

  const outcome = await tokens.get(input.baseToken, input.audience, exchange, {
    claim: url.searchParams.get('claim') !== '0',
    jitterMs: boundedInteger(url.searchParams.get('jitterMs'), DEFAULT_SETTINGS.jitterMs, 10_000),
    deadlineMs: boundedInteger(
      url.searchParams.get('deadlineMs'),
      DEFAULT_SETTINGS.deadlineMs,
      25_000
    ),
    keyPrefix: (url.searchParams.get('run') ?? '').slice(0, 64),
  });
  const times = tokenTimes(input.baseToken, outcome.status === 'ok' ? outcome.token : undefined);
  return Response.json(
    {
      instanceId,
      coldStart: invocations === 1,
      region: process.env.VERCEL_REGION ?? null,
      cacheBackend: cacheBackend(),
      status: outcome.status,
      detail: outcome.status === 'failed' ? outcome.detail : undefined,
      ...outcome.report,
      ...times,
      rateLimitHeaders,
      exchangedClaims,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
