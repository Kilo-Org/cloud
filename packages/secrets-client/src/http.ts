import {
  BundleResultSchema,
  STS_BUNDLE_HTTP_PATH,
  bundleResultHttpStatus,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { FIRST_LOAD_DEADLINE_MS, createSecrets } from './client';
import type { Secrets } from './types';

/**
 * One HTTP request may outlive the attempt that sent it: a fill of an empty bundle object can
 * take most of the first-load window, and its answer still lands after the client has started
 * a newer attempt.
 */
const REQUEST_TIMEOUT_MS = FIRST_LOAD_DEADLINE_MS;

export type HttpSecretsOptions = {
  /** Base URL of the STS Worker, for example `https://sts.kiloapps.io`. */
  stsUrl: string;
  /** Returns the caller's identity token for one request, for example a GitHub OIDC token. */
  getIdentityToken: () => string | Promise<string>;
  fetch?: typeof fetch;
};

/**
 * Reads the bundle over `POST /v1/bundle` for runtimes outside the Cloudflare account. A token
 * provider that fails or returns an empty token is a retryable failure, so the client keeps
 * serving the bundle it holds.
 */
export function createHttpSecrets(options: HttpSecretsOptions): Secrets {
  const url = `${options.stsUrl.replace(/\/+$/, '')}${STS_BUNDLE_HTTP_PATH}`;
  const fetchFn = options.fetch ?? fetch;

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
    return bundleResultFor(response, request);
  });
}

async function bundleResultFor(response: Response, request: BundleRequest): Promise<BundleResult> {
  if (response.status === 304) {
    const etag = response.headers.get('ETag') ?? request.ifNoneMatch ?? null;
    if (etag === null) throw new Error('STS answered 304 without an ETag');
    return {
      status: 'not_modified',
      etag,
      stale: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  const result = BundleResultSchema.parse(await response.json());
  const expected = bundleResultHttpStatus(result);
  if (expected !== response.status) {
    throw new Error(`STS answered ${response.status} for a ${result.status} result`);
  }
  return result;
}
