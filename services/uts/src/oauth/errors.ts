import { type OAuthErrorCode, UTS_DPOP_ALGORITHMS } from '@kilocode/uts-contracts';
import { IdentityStoreError } from '../db/client';
import { jsonResponse } from '../responses';

/**
 * Error responses of the token, revocation and introspection endpoints (RFC 6749 section 5.2,
 * RFC 7009, RFC 7662, RFC 9449). Every answer is `no-store`; a dependency failure answers 503 with
 * `Retry-After`, as the verifier does (design 7), and a failure no retry fixes answers 500.
 */

/** Seconds a client waits before it retries after a dependency failure. */
const RETRY_AFTER_SECONDS = '2';

export function oauthError(
  error: OAuthErrorCode,
  status: number,
  description?: string,
  headers: Record<string, string> = {}
): Response {
  return jsonResponse(
    description === undefined ? { error } : { error, error_description: description },
    status,
    { Pragma: 'no-cache', ...headers }
  );
}

/** RFC 9449, sections 5 and 7.1: the JSON error plus a `DPoP` challenge naming the algorithms. */
export function invalidDpopProof(description: string): Response {
  return oauthError('invalid_dpop_proof', 400, description, {
    'WWW-Authenticate': `DPoP error="invalid_dpop_proof", algs="${UTS_DPOP_ALGORITHMS.join(' ')}"`,
  });
}

export function temporarilyUnavailable(): Response {
  return oauthError('temporarily_unavailable', 503, undefined, {
    'Retry-After': RETRY_AFTER_SECONDS,
  });
}

/**
 * Logs an error thrown while an endpoint ran and says whether a retry can succeed: only a
 * retryable identity-store failure can. The log line carries the error's class and SQLSTATE, never
 * its message.
 */
export function classifyFailure(error: unknown, endpoint: string): 'retryable' | 'permanent' {
  if (error instanceof IdentityStoreError) {
    console.error(
      JSON.stringify({
        event: 'uts.oauth.store_failed',
        endpoint,
        failure: error.failure,
        sqlState: error.sqlState,
        constraint: error.constraint,
        systemCode: error.systemCode,
      })
    );
    return error.failure;
  }
  console.error(
    JSON.stringify({
      event: 'uts.oauth.failed',
      endpoint,
      error: error instanceof Error ? error.name : 'unknown',
    })
  );
  return 'permanent';
}

/** 503 for a failure a retry can fix, 500 for any other. */
export function failureResponse(error: unknown, endpoint: string): Response {
  return classifyFailure(error, endpoint) === 'retryable'
    ? temporarilyUnavailable()
    : oauthError('server_error', 500);
}
