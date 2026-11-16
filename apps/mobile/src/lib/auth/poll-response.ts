// Pure classification of a device-auth poll response's HTTP status. Kept
// free of any react-native/expo imports so it can be unit tested directly.

import { parseRetryAfterMs } from '@/lib/auth/auth-response-class';
import { type DeviceAuthError, deviceAuthErrorKey } from '@/lib/auth/device-auth-state';
import { parseAuthError } from '@/lib/auth/native-auth-contract';

type PollOutcome =
  | { readonly status: 'approved' }
  | { readonly status: 'pending' }
  | { readonly status: 'denied'; readonly message: DeviceAuthError }
  | { readonly status: 'expired'; readonly message: DeviceAuthError }
  | { readonly status: 'error'; readonly message: DeviceAuthError }
  | { readonly status: 'retry'; readonly retryAfterMs?: number };

export function classifyPollResponse(
  httpStatus: number,
  retryAfterHeader?: string | null,
  now?: number
): PollOutcome {
  if (httpStatus === 200) {
    return { status: 'approved' };
  }
  if (httpStatus === 202) {
    return { status: 'pending' };
  }
  if (httpStatus === 403) {
    return { status: 'denied', message: deviceAuthErrorKey('authErrors.accessDeniedByUser') };
  }
  if (httpStatus === 410) {
    return { status: 'expired', message: deviceAuthErrorKey('authErrors.codeExpired') };
  }
  // 429/5xx are transient (rate limiting or a flaky server) — keep polling,
  // and honour the server's own `Retry-After` when it named one instead of
  // only our own backoff.
  if (httpStatus === 429 || httpStatus >= 500) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
    return retryAfterMs === undefined ? { status: 'retry' } : { status: 'retry', retryAfterMs };
  }
  // Any other 4xx (400, 401, ...) is not something retrying will fix — and
  // 1xx/3xx are statuses this endpoint never returns, so treat them the same.
  return { status: 'error', message: deviceAuthErrorKey('authErrors.invalidToken') };
}

/**
 * The device-auth start refusal, read from its stable code. The server's own
 * sentence is never shown: the catalog owns the copy in the active language.
 */
export function getDeviceAuthStartRefusalError(body: unknown): DeviceAuthError {
  return deviceAuthErrorKey(
    parseAuthError(body)?.code === 'RATE_LIMITED'
      ? 'authErrors.tooManySignInAttempts'
      : 'authErrors.startSignInFailed'
  );
}
