/**
 * One classification for a sign-in HTTP response, shared by the native auth
 * POST helper (`auth-fetch`) and the refresh rotation (`credentials`).
 *
 * The production defect this encodes: a terminal refusal (the credential is
 * gone, or the server sent a 4xx with no retry guidance) was treated as a
 * transient one, so the client kept the dead credential and kept asking — the
 * same request reported over and over. A terminal answer must stop the loop,
 * clear the credential it proves dead, and put the person back on sign-in.
 *
 * Pure and dependency-free apart from the telemetry sink, so both the fetch
 * boundary and the node test environment can import it.
 */

import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * The one route whose 401 proves the *stored* credential is gone.
 *
 * `native/refresh` consumes the stored refresh token, so a 401 there (unknown,
 * expired, or reused refresh token — see the frozen route contract) is the
 * pair itself being refused: it is cleared, the loop stops, and the person
 * signs in again. A 401 on `native/token` is different: that route takes no
 * bearer, so it refuses the provider credential the *attempt* presented (an
 * email code, a one-time ticket, an Apple/Google ID token). It is terminal for
 * that attempt — never retried — but it is not proof a stored session is dead,
 * and clearing one on a mistyped code would sign out a healthy device.
 */
const STORED_CREDENTIAL_ROUTE = '/api/auth/native/refresh';

export type AuthResponseClass =
  /** 2xx: the route answered. */
  | { readonly kind: 'success' }
  /**
   * Do not retry. `clearCredential` is true when the refusal proves the stored
   * pair is dead (a 401 on the refresh route).
   */
  | { readonly kind: 'terminal'; readonly status: number; readonly clearCredential: boolean }
  /** Retryable: a 429 carries the server's own back-off, if it named one. */
  | { readonly kind: 'retry'; readonly status: number; readonly retryAfterMs: number | undefined };

/**
 * `Retry-After` as milliseconds from `now`. Accepts both forms RFC 9110 allows
 * — delta-seconds and an HTTP-date — and returns `undefined` for anything else
 * so an unparseable header never invents a wait. A date in the past is 0.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (header === null || header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return Math.max(0, parsed - now);
}

/**
 * Classify a sign-in response. A 401 is terminal (and clears the stored
 * credential on a credential route). A 429 or 5xx is retryable and carries the
 * server's `Retry-After` when it sent one. Every other 4xx — and the 1xx/3xx a
 * sign-in route never returns — is terminal: retrying it cannot change it.
 */
export function classifyAuthResponse(args: {
  path: string;
  status: number;
  retryAfterHeader?: string | null;
  now?: number;
}): AuthResponseClass {
  const { path, status } = args;
  if (status >= 200 && status < 300) {
    return { kind: 'success' };
  }
  if (status === 401) {
    return { kind: 'terminal', status, clearCredential: path === STORED_CREDENTIAL_ROUTE };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return {
      kind: 'retry',
      status,
      retryAfterMs: parseRetryAfterMs(args.retryAfterHeader, args.now),
    };
  }
  return { kind: 'terminal', status, clearCredential: false };
}

/**
 * The stable fingerprint of one terminal sign-in failure. It names the route
 * and the status only — never the retry count, a duration, or a token — so
 * every repeat collapses into the same issue instead of counting once per try.
 */
export function authTerminalFingerprint(route: string, status: number): string[] {
  return ['auth-terminal', route, String(status)];
}

// One report per terminal failure per app process, keyed by the same route and
// status the fingerprint names. The retry loop is what produced a report per
// try; once it stops, this is the belt-and-braces that keeps a late duplicate
// from opening a second event for the same dead credential.
const reportedTerminalFailures = new Set<string>();

/** Test seam: forget the process's terminal reports. */
export function resetAuthTerminalReports(): void {
  reportedTerminalFailures.clear();
}

/** True when this exact terminal failure has not been reported yet. */
export function shouldReportAuthTerminalFailure(route: string, status: number): boolean {
  const key = `${route}:${status}`;
  if (reportedTerminalFailures.has(key)) {
    return false;
  }
  reportedTerminalFailures.add(key);
  return true;
}

/**
 * Report one terminal sign-in failure, at most once per process, with the
 * stable fingerprint above. Never throws; a no-op until a telemetry sink is
 * installed.
 */
export function reportAuthTerminalFailure(route: string, status: number): void {
  if (!shouldReportAuthTerminalFailure(route, status)) {
    return;
  }
  captureTelemetry({
    level: 'error',
    error: new Error(`Terminal sign-in failure: ${status} on ${route}`),
    tags: {
      'error.subsystem': 'auth',
      'auth.outcome': 'terminal',
      'auth.route': route,
      'http.status': status,
    },
    contexts: { auth: { route, status, outcome: 'terminal' } },
    fingerprint: authTerminalFingerprint(route, status),
  });
}
