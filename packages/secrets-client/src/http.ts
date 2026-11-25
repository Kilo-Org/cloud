import {
  BundleResultSchema,
  STS_BUNDLE_HTTP_PATH,
  bundleResultHttpStatus,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { createSecrets } from './client';
import type { Secrets, SecretsClock } from './types';

const REQUEST_TIMEOUT_MS = 5_000;

export type HttpSecretsOptions = {
  /** Base URL of the STS Worker, for example `https://sts.kiloapps.io`. */
  stsUrl: string;
  /** Returns the caller's identity token for one request; see `vercelIdentityToken`. */
  getIdentityToken: () => string | Promise<string>;
  fetch?: typeof fetch;
  clock?: SecretsClock;
};

/**
 * Reads the bundle over `POST /v1/bundle` for runtimes outside the Cloudflare account, such as
 * Vercel functions. A 304 carries no body: the mapped result confirms the held values, so the
 * copy stays usable and is labelled with the confirmation time.
 */
export function createHttpSecrets(options: HttpSecretsOptions): Secrets {
  const url = `${options.stsUrl.replace(/\/+$/, '')}${STS_BUNDLE_HTTP_PATH}`;
  const fetchFn = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;

  return createSecrets(async request => {
    const token = await options.getIdentityToken();
    if (!token) throw new Error('STS identity token is empty');

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (request.ifNoneMatch !== undefined) headers['If-None-Match'] = request.ifNoneMatch;

    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return bundleResultFor(response, request, clock);
  }, options);
}

async function bundleResultFor(
  response: Response,
  request: BundleRequest,
  clock: SecretsClock
): Promise<BundleResult> {
  if (response.status === 304) {
    const etag = response.headers.get('ETag') ?? request.ifNoneMatch ?? null;
    if (etag === null) throw new Error('STS answered 304 without an ETag');
    return {
      status: 'not_modified',
      etag,
      stale: false,
      fetchedAt: new Date(clock()).toISOString(),
    };
  }

  const result = BundleResultSchema.parse(await response.json());
  const expected = bundleResultHttpStatus(result);
  if (expected !== response.status) {
    throw new Error(`STS answered ${response.status} for a ${result.status} result`);
  }
  return result;
}
