/**
 * The Hugging Face catalog's HTTP boundary. One request, and the answer classified
 * so a query retries only what a retry can change and so a screen can tell a
 * repository that is gone from one this app may not read.
 *
 * Nothing here reports: the app's global fetch wrapper already records every
 * error-status response once (a warning event for a status that names a defect,
 * a breadcrumb for the expected answers) and every transport failure as a
 * breadcrumb. The declaration below keeps the app-wide query reporter from filing
 * a second record for the same failure.
 */

import { isAbortError } from '@/lib/telemetry/abort-classification';
import { TELEMETRY_DESCRIPTION_KEY, type TelemetryDescription } from '@/lib/telemetry/error-sink';

/**
 * The catalog's HTTP boundary failed. The status is Hugging Face's own answer, and
 * undefined when the request never got one (no network, a reset, an unreachable
 * host). Hugging Face answers 401 both for a repository that does not exist and
 * for one it will not disclose to this app, so the status alone names the state:
 * 404 is gone, 401 and 403 are out of reach, anything else is unexpected.
 */
export class HfRequestError extends Error {
  readonly status: number | undefined;
  readonly [TELEMETRY_DESCRIPTION_KEY]: TelemetryDescription;

  constructor(status: number | undefined, cause?: unknown) {
    super(
      status === undefined
        ? 'Hugging Face could not be reached'
        : `Hugging Face answered ${status}`,
      cause === undefined ? undefined : { cause }
    );
    this.name = 'HfRequestError';
    this.status = status;
    this[TELEMETRY_DESCRIPTION_KEY] = {
      level: 'warning',
      fingerprint: ['hf-catalog', status === undefined ? 'transport' : `http.${status}`],
      report: 'none',
      tags: {
        'error.subsystem': 'hf-catalog',
        ...(status === undefined ? {} : { 'http.status': status }),
      },
    };
  }
}

/** A repository that no longer exists: the same 404 will not change on a retry. */
export const isHfGone = (error: unknown): boolean =>
  error instanceof HfRequestError && error.status === 404;

/** A repository this app cannot read: private, access-restricted, or never disclosed. */
export const isHfRestricted = (error: unknown): boolean =>
  error instanceof HfRequestError && (error.status === 401 || error.status === 403);

/**
 * Retry a catalog request twice, and only when a retry can answer differently: a
 * rate limit, an upstream failure, or a request that never got an answer. A
 * refusal, and a successful answer whose body breaks the wire contract, are final.
 */
export function retryHfQuery(failures: number, error: Error): boolean {
  if (failures >= 2 || !(error instanceof HfRequestError)) {
    return false;
  }
  if (error.status === undefined) {
    return true;
  }
  return error.status === 429 || (error.status >= 500 && error.status < 600);
}

export type HfResponse = {
  readonly body: unknown;
  /** The `link` header, which carries the next page of a listing. */
  readonly link: string | null;
};

async function fetchJson(url: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    // A cancelled query is not a failure: hand the abort back unchanged so the
    // query layer recognizes it and no reporter files it.
    if (isAbortError(error)) {
      throw error;
    }
    throw new HfRequestError(undefined, error);
  }
}

/** One JSON request to Hugging Face, without credentials: the app never holds an account. */
export async function hfGet(url: string, signal: AbortSignal): Promise<HfResponse> {
  const response = await fetchJson(url, signal);
  if (!response.ok) {
    throw new HfRequestError(response.status);
  }
  const body: unknown = await response.json();
  return { body, link: response.headers.get('link') };
}
