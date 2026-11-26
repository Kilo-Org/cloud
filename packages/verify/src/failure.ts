/**
 * Failure results and their HTTP shape (design 7, error responses). Bodies and headers name the
 * error class only; `reason` is for the caller's logs and tests and is never sent. Nothing here
 * carries a token value.
 */

/** Which rule refused the request. */
export type FailureReason =
  | 'missing_credential'
  | 'malformed_token'
  | 'header_extension'
  | 'algorithm'
  | 'kid_missing'
  | 'type'
  | 'issuer'
  | 'issuer_per_route'
  | 'not_token_key'
  | 'unknown_kid'
  | 'signature'
  | 'claims'
  | 'identity'
  | 'time'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_in_future'
  | 'audience'
  | 'scope_unknown'
  | 'scope_mismatch'
  | 'pat_not_eligible'
  | 'org_mismatch'
  | 'session_required'
  | 'revoked_subject'
  | 'revoked_session'
  | 'revoked_kid'
  | 'blocked_account'
  | 'pat_not_accepted'
  | 'pat_malformed'
  | 'pat_not_found'
  | 'pat_revoked'
  | 'pat_expired'
  | 'pat_rate_limited'
  | 'pat_client_address_missing'
  | 'jwks_unavailable'
  | 'bootstrap_unavailable'
  | 'feed_unavailable'
  | 'pat_lookup_unavailable';

export type FailureError =
  | 'invalid_request'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'org_mismatch'
  | 'temporarily_unavailable'
  | 'too_many_requests';

export type FailureBody = { error: FailureError; scope?: string };

export type VerifyFailure = {
  ok: false;
  status: 400 | 401 | 403 | 429 | 503;
  /** null only for a request with no credential, which gets the bare RFC 9728 challenge. */
  error: FailureError | null;
  reason: FailureReason;
  headers: Record<string, string>;
  body: FailureBody | null;
};

/** Builds failures that share one `resource_metadata` URL. */
export type Failures = {
  missingCredential(): VerifyFailure;
  invalidToken(reason: FailureReason): VerifyFailure;
  insufficientScope(reason: FailureReason, requiredScope: string): VerifyFailure;
  orgMismatch(): VerifyFailure;
  unavailable(reason: FailureReason, retryAfterSeconds: number): VerifyFailure;
  rateLimited(retryAfterSeconds: number): VerifyFailure;
  /** The request lacks what the check needs from the caller, such as a client address for a PAT. */
  invalidRequest(reason: FailureReason): VerifyFailure;
};

const NO_STORE = { 'cache-control': 'no-store' };

export function createFailures(resourceMetadataUrl: string): Failures {
  const metadata = `resource_metadata="${resourceMetadataUrl}"`;
  return {
    missingCredential: () => ({
      ok: false,
      status: 401,
      error: null,
      reason: 'missing_credential',
      headers: { ...NO_STORE, 'www-authenticate': `Bearer ${metadata}` },
      body: null,
    }),
    invalidToken: reason => ({
      ok: false,
      status: 401,
      error: 'invalid_token',
      reason,
      headers: { ...NO_STORE, 'www-authenticate': `Bearer error="invalid_token", ${metadata}` },
      body: { error: 'invalid_token' },
    }),
    insufficientScope: (reason, requiredScope) => ({
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      reason,
      headers: {
        ...NO_STORE,
        'www-authenticate': `Bearer error="insufficient_scope", scope="${requiredScope}", ${metadata}`,
      },
      body: { error: 'insufficient_scope', scope: requiredScope },
    }),
    orgMismatch: () => ({
      ok: false,
      status: 403,
      error: 'org_mismatch',
      reason: 'org_mismatch',
      headers: { ...NO_STORE },
      body: { error: 'org_mismatch' },
    }),
    unavailable: (reason, retryAfterSeconds) => ({
      ok: false,
      status: 503,
      error: 'temporarily_unavailable',
      reason,
      headers: { ...NO_STORE, 'retry-after': String(retryAfterSeconds) },
      body: { error: 'temporarily_unavailable' },
    }),
    rateLimited: retryAfterSeconds => ({
      ok: false,
      status: 429,
      error: 'too_many_requests',
      reason: 'pat_rate_limited',
      headers: { ...NO_STORE, 'retry-after': String(retryAfterSeconds) },
      body: { error: 'too_many_requests' },
    }),
    invalidRequest: reason => ({
      ok: false,
      status: 400,
      error: 'invalid_request',
      reason,
      headers: { ...NO_STORE, 'www-authenticate': `Bearer error="invalid_request", ${metadata}` },
      body: { error: 'invalid_request' },
    }),
  };
}

/** The HTTP response for a failure: JSON body when there is one, the failure's headers always. */
export function failureResponse(failure: VerifyFailure): Response {
  if (failure.body === null) {
    return new Response(null, { status: failure.status, headers: failure.headers });
  }
  return Response.json(failure.body, { status: failure.status, headers: failure.headers });
}
