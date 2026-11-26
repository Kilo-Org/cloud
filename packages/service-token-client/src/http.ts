import {
  MintResultSchema,
  mintResultHttpStatus,
  type MintRequest,
  type MintResult,
} from '@kilocode/sts-contracts';
import { createServiceTokens } from './client';
import type { ServiceTokens } from './types';

/** The STS mint route for callers outside the Cloudflare account (`services/sts` README). */
export const STS_TOKEN_HTTP_PATH = '/v1/token';
/** One mint request: STS's 5 s signer deadline plus transit. */
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The identity step can take up to 20 s on a cold Vercel wave (the shared exchange, design 4.4),
 * then the mint request itself.
 */
export const HTTP_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Returns the caller's identity token for one attempt. `invalidate`, when the source caches
 * tokens it did not obtain itself (the shared Vercel cache), hears of every token STS refused:
 * it drops one it took from that cache and says whether it did, so the next call can return a
 * different one.
 */
export type IdentityTokenSource = {
  (): string | Promise<string>;
  invalidate?: (token: string) => Promise<boolean>;
};

export type HttpServiceTokensOptions = {
  /** Base URL of the STS Worker, for example `https://sts.kiloapps.io`. */
  stsUrl: string;
  /**
   * Returns the caller's identity token for one attempt: a Vercel token exchanged for the STS
   * audience (`vercelIdentity` from `@kilocode/service-token-client/vercel`), a GitHub or Fly OIDC
   * token. Called inside the request that starts the attempt.
   */
  getIdentityToken: IdentityTokenSource;
  fetch?: typeof fetch;
};

/**
 * Mints over `POST /v1/token`. An identity provider that fails or returns an empty token is a
 * retryable failure, so the client keeps serving the tokens it holds. When STS answers
 * `identity_rejected`, the identity source hears of it through `invalidate`; when it drops a
 * token it took from a shared cache, the same attempt asks once more with a fresh one. A second
 * refusal is the attempt's answer and reaches `invalidate` too, so the source can stop asking for
 * fresh tokens (the Vercel source's refusal marker): one refusal costs at most one more identity
 * token and one more mint per attempt, and the client asks again only after `DENIED_RECHECK_MS`.
 */
export function createHttpServiceTokens(options: HttpServiceTokensOptions): ServiceTokens {
  const url = `${options.stsUrl.replace(/\/+$/, '')}${STS_TOKEN_HTTP_PATH}`;
  const fetchFn = options.fetch ?? fetch;
  const identity = options.getIdentityToken;

  async function mintWith(request: MintRequest): Promise<{ token: string; result: MintResult }> {
    const token = await identity();
    if (!token) throw new Error('STS identity token is empty');
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      // The request carries the identity token: a redirect is never followed, it fails the attempt.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(`STS answered a redirect (${response.status})`);
    }
    const result: MintResult = MintResultSchema.parse(await response.json());
    // STS answers 413 with the invalid_request body for a body past its budget.
    const expected = mintResultHttpStatus(result);
    if (response.status !== expected && !(response.status === 413 && expected === 400)) {
      throw new Error(`STS answered ${response.status} for a ${result.status} result`);
    }
    return { token, result };
  }

  return createServiceTokens(
    async request => {
      const first = await mintWith(request);
      if (first.result.status !== 'identity_rejected' || identity.invalidate === undefined) {
        return first.result;
      }
      if (!(await identity.invalidate(first.token))) return first.result;
      const second = await mintWith(request);
      if (second.result.status === 'identity_rejected') await identity.invalidate(second.token);
      return second.result;
    },
    { attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS }
  );
}
