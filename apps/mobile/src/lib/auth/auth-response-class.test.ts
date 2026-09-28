import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authTerminalFingerprint,
  classifyAuthResponse,
  parseRetryAfterMs,
  reportAuthTerminalFailure,
  resetAuthTerminalReports,
  shouldReportAuthTerminalFailure,
} from '@/lib/auth/auth-response-class';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

describe('parseRetryAfterMs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('  5  ')).toBe(5000);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-09-23T02:00:00Z');
    expect(parseRetryAfterMs('Wed, 23 Sep 2026 02:00:45 GMT', now)).toBe(45_000);
  });

  it('floors a date already in the past at zero', () => {
    const now = Date.parse('2026-09-23T02:00:00Z');
    expect(parseRetryAfterMs('Wed, 23 Sep 2026 01:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('later please')).toBeUndefined();
  });
});

describe('classifyAuthResponse', () => {
  it('classifies a 2xx as success', () => {
    expect(classifyAuthResponse({ path: '/api/auth/native/token', status: 200 })).toEqual({
      kind: 'success',
    });
  });

  it('classifies a 401 on the refresh route as terminal and clears the stored pair', () => {
    expect(classifyAuthResponse({ path: '/api/auth/native/refresh', status: 401 })).toEqual({
      kind: 'terminal',
      status: 401,
      clearCredential: true,
    });
  });

  it('keeps a 401 on native/token terminal without clearing the stored pair', () => {
    // native/token takes no bearer: its 401 refuses the attempt's provider
    // credential (a code, a ticket, an ID token), not the stored session.
    expect(classifyAuthResponse({ path: '/api/auth/native/token', status: 401 })).toEqual({
      kind: 'terminal',
      status: 401,
      clearCredential: false,
    });
  });

  it('keeps a 401 on a non-credential route terminal without clearing the session', () => {
    expect(classifyAuthResponse({ path: '/api/auth/passkey/authenticate', status: 401 })).toEqual({
      kind: 'terminal',
      status: 401,
      clearCredential: false,
    });
  });

  it('classifies a 429 as retryable and carries Retry-After', () => {
    expect(
      classifyAuthResponse({ path: '/api/auth/native/otp', status: 429, retryAfterHeader: '12' })
    ).toEqual({ kind: 'retry', status: 429, retryAfterMs: 12_000 });
    expect(classifyAuthResponse({ path: '/api/auth/native/otp', status: 429 })).toEqual({
      kind: 'retry',
      status: 429,
      retryAfterMs: undefined,
    });
  });

  it('classifies 5xx as retryable', () => {
    expect(classifyAuthResponse({ path: '/api/auth/native/token', status: 503 })).toEqual({
      kind: 'retry',
      status: 503,
      retryAfterMs: undefined,
    });
  });

  it.each([400, 403, 404, 409, 425])(
    'classifies a 4xx with no retry guidance (%i) as terminal and never retries it',
    status => {
      expect(classifyAuthResponse({ path: '/api/auth/native/token', status })).toEqual({
        kind: 'terminal',
        status,
        clearCredential: false,
      });
    }
  );
});

describe('terminal failure reporting', () => {
  afterEach(() => {
    setTelemetrySink(null);
    resetAuthTerminalReports();
  });

  it('uses one stable fingerprint for every repeat of the same failure', () => {
    expect(authTerminalFingerprint('/api/auth/native/token', 401)).toEqual(
      authTerminalFingerprint('/api/auth/native/token', 401)
    );
    expect(authTerminalFingerprint('/api/auth/native/token', 401)).not.toEqual(
      authTerminalFingerprint('/api/auth/native/refresh', 401)
    );
  });

  it('reports each terminal failure once, not once per retry', () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });

    reportAuthTerminalFailure('/api/auth/native/token', 401);
    reportAuthTerminalFailure('/api/auth/native/token', 401);
    reportAuthTerminalFailure('/api/auth/native/token', 401);

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('error');
    expect(events[0]?.fingerprint).toEqual(['auth-terminal', '/api/auth/native/token', '401']);
  });

  it('reports a distinct terminal failure separately', () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });

    reportAuthTerminalFailure('/api/auth/native/token', 401);
    reportAuthTerminalFailure('/api/auth/native/refresh', 401);

    expect(events).toHaveLength(2);
  });

  it('reports nothing when no sink is installed', () => {
    expect(() => {
      reportAuthTerminalFailure('/api/auth/native/token', 401);
    }).not.toThrow();
  });

  it('marks the first terminal failure as reportable and later repeats as not', () => {
    resetAuthTerminalReports();
    expect(shouldReportAuthTerminalFailure('/api/auth/native/refresh', 401)).toBe(true);
    expect(shouldReportAuthTerminalFailure('/api/auth/native/refresh', 401)).toBe(false);
  });
});
