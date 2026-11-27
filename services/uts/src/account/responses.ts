import { UTS_PROTECTED_RESOURCE_METADATA_PATH } from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import { jsonResponse } from '../responses';

/**
 * Error answers of the account API and the PAT probe route (RFC 6750 section 3, RFC 9728 section
 * 5.1, design 7): a JSON body `{ error, error_description }`, `no-store`, and for 401 and 403 a
 * `WWW-Authenticate` challenge that names the resource metadata.
 */

export type AccountErrorCode =
  | 'invalid_request'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'invalid_scope'
  | 'org_mismatch'
  | 'access_denied'
  | 'not_found'
  | 'limit_reached'
  | 'not_flagged'
  | 'lapsed'
  | 'too_many_requests'
  | 'temporarily_unavailable'
  | 'method_not_allowed';

export function accountError(
  error: AccountErrorCode,
  status: number,
  description: string,
  headers: Record<string, string> = {}
): Response {
  return jsonResponse({ error, error_description: description }, status, headers);
}

function resourceMetadata(config: UtsConfig): string {
  return `resource_metadata="${config.endpoints.issuer}${UTS_PROTECTED_RESOURCE_METADATA_PATH}"`;
}

/** No credential: the challenge names the metadata and no error (RFC 6750 section 3.1). */
export function credentialMissing(config: UtsConfig): Response {
  return accountError('invalid_token', 401, 'a bearer credential is required', {
    'WWW-Authenticate': `Bearer ${resourceMetadata(config)}`,
  });
}

export function credentialInvalid(config: UtsConfig, description: string): Response {
  return accountError('invalid_token', 401, description, {
    'WWW-Authenticate': `Bearer error="invalid_token", ${resourceMetadata(config)}`,
  });
}

export function insufficientScope(config: UtsConfig, scope: string): Response {
  return accountError('insufficient_scope', 403, `this route needs the scope ${scope}`, {
    'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}", ${resourceMetadata(config)}`,
  });
}

export function dependencyUnavailable(retryAfterSeconds: number): Response {
  return accountError('temporarily_unavailable', 503, 'try again later', {
    'Retry-After': String(retryAfterSeconds),
  });
}

export function methodNotAllowed(allow: string): Response {
  return accountError('method_not_allowed', 405, `use ${allow}`, { Allow: allow });
}
