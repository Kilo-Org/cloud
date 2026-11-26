import { getVercelOidcToken } from '@vercel/oidc';
import {
  SharedExchangedToken,
  type Exchange,
  type SharedCache,
  type SharedTokenSettings,
} from './shared-token';

export {
  DEFAULT_SETTINGS,
  SharedExchangedToken,
  cacheTtlSeconds,
  expOf,
} from './shared-token';
export type {
  Clock,
  Exchange,
  ExchangeAttempt,
  SharedCache,
  SharedTokenReport,
  SharedTokenResult,
  SharedTokenSettings,
  TokenSource,
} from './shared-token';

/**
 * Vercel's custom-audience exchange, the endpoint `exchangeVercelOidcToken` in `@vercel/oidc`
 * calls (https://vercel.com/docs/oidc/reference). The client calls it itself: the shared-cache
 * algorithm must tell a 429 from other failures, and `@vercel/oidc` reports every failure as one
 * plain `Error`.
 */
export const VERCEL_EXCHANGE_URL = 'https://oidc.vercel.com/~token';
const EXCHANGE_TIMEOUT_MS = 10_000;

export type VercelIdentityOptions = {
  /** The STS issuer of the environment the function calls, for example `https://sts.kiloapps.io`. */
  stsAudience: string;
  /**
   * The Vercel Runtime Cache, for example
   * `getCache({ namespace: 'sts-exchange', keyHashFunction: key => key })` from `@vercel/functions`.
   * The keys are SHA-256 already; the package's default 32-bit key hash could let two keys share an
   * entry.
   */
  cache: SharedCache;
  /** The function's own OIDC token; defaults to `getVercelOidcToken()` from `@vercel/oidc`. */
  getBaseToken?: () => Promise<string>;
  /** Defaults to one POST to `VERCEL_EXCHANGE_URL`. */
  exchange?: Exchange;
  settings?: Partial<SharedTokenSettings>;
};

/**
 * One exchange: `{ token, aud }` to Vercel, which answers a token with the base token's `exp`, the
 * given `aud` and an `act` claim. Only the status reaches the caller on a failure: an error body
 * could echo the token.
 */
export function vercelExchange(fetchFn: typeof fetch = fetch): Exchange {
  return async (baseToken, audience) => {
    let response: Response;
    try {
      response = await fetchFn(VERCEL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token: baseToken, aud: audience }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      return { kind: 'failed', detail: `the exchange request failed (${name})` };
    }
    if (response.status === 429) {
      await response.body?.cancel();
      return { kind: 'rate_limited' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'failed', detail: `the exchange answered ${response.status}` };
    }
    const body: unknown = await response.json().catch(() => null);
    if (typeof body === 'object' && body !== null && 'token' in body) {
      if (typeof body.token === 'string' && body.token !== '') {
        return { kind: 'token', token: body.token };
      }
    }
    return { kind: 'failed', detail: 'the exchange answered no token' };
  };
}

/**
 * The identity a Vercel function presents to STS (`getIdentityToken` of `createHttpServiceTokens`).
 * Create it once per instance, at module scope; each call reads the function's own OIDC token from
 * the request, never at module scope, and returns a token whose only audience is `stsAudience`,
 * shared across the deployment's instances through the Runtime Cache (decision Q49): used until
 * 60 seconds before its own `exp`; on a miss a random wait and a re-read, then a claim marker so one
 * request exchanges; no second exchange after a 429 while the marker lives; a request with no token
 * after 20 seconds, or with a base token that has under 60 seconds left on a miss, fails.
 */
export function vercelIdentity(options: VercelIdentityOptions): () => Promise<string> {
  const shared = new SharedExchangedToken(options.cache, { settings: options.settings });
  const exchange = options.exchange ?? vercelExchange();
  const getBaseToken = options.getBaseToken ?? (() => getVercelOidcToken());
  return async () => {
    const result = await shared.get(await getBaseToken(), options.stsAudience, exchange);
    if (result.status === 'failed') {
      throw new Error(`no Vercel token for the STS audience: ${result.detail}`);
    }
    return result.token;
  };
}
