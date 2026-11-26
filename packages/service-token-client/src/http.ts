import { MintResultSchema, mintResultHttpStatus, type MintResult } from '@kilocode/sts-contracts';
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

export type HttpServiceTokensOptions = {
  /** Base URL of the STS Worker, for example `https://sts.kiloapps.io`. */
  stsUrl: string;
  /**
   * Returns the caller's identity token for one attempt: a Vercel token exchanged for the STS
   * audience (`vercelIdentity` from `@kilocode/service-token-client/vercel`), a GitHub or Fly OIDC
   * token. Called inside the request that starts the attempt.
   */
  getIdentityToken: () => string | Promise<string>;
  fetch?: typeof fetch;
};

/**
 * Mints over `POST /v1/token`. An identity provider that fails or returns an empty token is a
 * retryable failure, so the client keeps serving the tokens it holds.
 */
export function createHttpServiceTokens(options: HttpServiceTokensOptions): ServiceTokens {
  const url = `${options.stsUrl.replace(/\/+$/, '')}${STS_TOKEN_HTTP_PATH}`;
  const fetchFn = options.fetch ?? fetch;

  return createServiceTokens(
    async request => {
      const token = await options.getIdentityToken();
      if (!token) throw new Error('STS identity token is empty');
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const result: MintResult = MintResultSchema.parse(await response.json());
      // STS answers 413 with the invalid_request body for a body past its budget.
      const expected = mintResultHttpStatus(result);
      if (response.status !== expected && !(response.status === 413 && expected === 400)) {
        throw new Error(`STS answered ${response.status} for a ${result.status} result`);
      }
      return result;
    },
    { attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS }
  );
}
