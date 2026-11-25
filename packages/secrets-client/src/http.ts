import {
  BundleResultSchema,
  STS_BUNDLE_HTTP_PATH,
  STS_FETCHED_AT_HEADER,
  STS_STALE_HEADER,
  bundleResultHttpStatus,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { z } from 'zod';
import { FIRST_LOAD_DEADLINE_MS, createSecrets } from './client';
import type { Secrets } from './types';

/**
 * One HTTP request may outlive the attempt that sent it: a fill of an empty bundle object can
 * take most of the first-load window, and its answer still lands after the client has started
 * a newer attempt.
 */
const REQUEST_TIMEOUT_MS = FIRST_LOAD_DEADLINE_MS;

const FetchedAtSchema = z.iso.datetime();

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
      stale: staleHeader(response.headers.get(STS_STALE_HEADER)),
      fetchedAt: fetchedAtHeader(response.headers.get(STS_FETCHED_AT_HEADER)),
    };
  }

  const result = BundleResultSchema.parse(await response.json());
  const expected = bundleResultHttpStatus(result);
  if (expected !== response.status) {
    throw new Error(`STS answered ${response.status} for a ${result.status} result`);
  }
  return result;
}

/** An STS release that predates the header sends none; its 304 means a fresh copy. */
function staleHeader(value: string | null): boolean {
  switch (value) {
    case null:
    case 'false':
      return false;
    case 'true':
      return true;
    default:
      throw new Error(`STS answered 304 with an invalid ${STS_STALE_HEADER} header`);
  }
}

/** Without the header the 304 is labelled with the time this client received it. */
function fetchedAtHeader(value: string | null): string {
  if (value === null) return new Date().toISOString();
  const parsed = FetchedAtSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`STS answered 304 with an invalid ${STS_FETCHED_AT_HEADER} header`);
  }
  return parsed.data;
}
