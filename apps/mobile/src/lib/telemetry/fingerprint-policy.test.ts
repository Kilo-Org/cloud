/**
 * Fingerprint-policy proof.
 *
 * Drives the real telemetry sink (`installSentrySink`, via
 * `installErrorReporting`) and the real `beforeSend` (`scrubEvent`), then groups
 * the captured events the way Sentry would — by fingerprint. One pair differs
 * only by the ephemeral port, one only by the build worktree path, one only by
 * host and port, and one differs in the HTTP outcome (401 against 412).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureTelemetry } from '@/lib/telemetry/error-sink';
import { reportNetworkError } from '@/lib/telemetry/network-errors';
import { NETWORK_BODY_CONTEXT, scrubEvent } from '@/lib/telemetry/sentry-scrub';
import { installErrorReporting } from './install-error-reporting';

const sentryMock = vi.hoisted(() => ({
  captureException: vi.fn<(error: unknown, options?: Record<string, unknown>) => void>(),
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/react-native', () => sentryMock);

const INSTALLED_FLAG = '__kiloErrorReportingInstalled__';

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal(INSTALLED_FLAG, undefined);
  installErrorReporting();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sentryMock.captureException.mockClear();
});

/** A captured event after the real `beforeSend` (`scrubEvent`) has run. */
type ScrubbedEvent = {
  fingerprint?: unknown;
  contexts?: Record<string, unknown>;
};

/**
 * The event the SDK hands to `beforeSend` for a captured error, after
 * `extraErrorDataIntegration` has run: the integration writes the thrown
 * error's own properties (none, for our synthetic `Error`) under
 * `contexts[error.name]`, so that key is replaced with `{}` regardless of what
 * the capture site stored there.
 */
function sdkEvent(error: unknown, options: Record<string, unknown> | undefined): unknown {
  const type = error instanceof Error && error.name.length > 0 ? error.name : 'Error';
  const value = error instanceof Error ? error.message : undefined;
  const exception: Record<string, unknown> = { type };
  if (value !== undefined) {
    exception.value = value;
  }
  const contexts = {
    ...(options?.contexts as Record<string, unknown> | undefined),
    [type]: {},
  };
  return { ...options, exception: { values: [exception] }, contexts };
}

/**
 * Build the event the SDK would send for a captured error and run it through
 * the app's real `beforeSend` (`scrubEvent`), which is the policy under test.
 */
function scrubCapture(error: unknown, options: Record<string, unknown> | undefined): ScrubbedEvent {
  return scrubEvent(sdkEvent(error, options)) as ScrubbedEvent;
}

/** The Sentry group key: the fingerprint, or the SDK default when there is none. */
function groupKey(event: ScrubbedEvent): string {
  const fingerprint = event.fingerprint;
  return Array.isArray(fingerprint) ? fingerprint.join(' | ') : '<sentry-default>';
}

function groupKeys(): string[] {
  return sentryMock.captureException.mock.calls.map(([error, options]) =>
    groupKey(scrubCapture(error, options))
  );
}

describe('fingerprint policy', () => {
  it('groups two events that differ only by the ephemeral port', () => {
    for (const port of [10_416, 10_216]) {
      reportNetworkError({
        source: 'fetch',
        url: `http://127.0.0.1:${port}/v1/latency`,
        method: 'POST',
        status: 401,
        durationMs: 5,
      });
    }

    const [first, second] = groupKeys();
    expect(first).toBe('network-error | fetch | /v1/latency | http.401');
    expect(second).toBe(first);
  });

  it('groups two unhandled events that differ only by the build worktree path', () => {
    for (const root of ['/home/ci/worktrees/a1', '/home/ci/worktrees/b2']) {
      captureTelemetry({
        level: 'error',
        error: new Error(
          `fetch failed at ${root}/apps/mobile/node_modules/expo-modules-core/build/ExpoFetch.ts:12:3`
        ),
      });
    }

    const [first, second] = groupKeys();
    expect(first).toBe('Error | fetch failed at <path>');
    expect(second).toBe(first);
  });

  it('groups two unhandled native failures that differ only by host and port', () => {
    for (const target of ['/127.0.0.1:10416', '/10.0.2.2:8080']) {
      captureTelemetry({
        level: 'error',
        error: new Error(
          `Error: fetch failed: java.net.ConnectException: Failed to connect to ${target}`
        ),
      });
    }

    const [first, second] = groupKeys();
    expect(first).toBe(
      'Error | Error: fetch failed: java.net.ConnectException: Failed to connect to <host>'
    );
    expect(second).toBe(first);
  });

  it('separates two events that differ in the HTTP outcome (401 against 412)', () => {
    for (const status of [401, 412]) {
      reportNetworkError({
        source: 'trpc',
        url: 'http://127.0.0.1:10416/api/trpc/activeSessions.createWebTicket',
        method: 'POST',
        status,
        durationMs: 5,
      });
    }

    const [first, second] = groupKeys();
    expect(first).toBe('network-error | trpc | activeSessions.createWebTicket | http.401');
    expect(second).toBe('network-error | trpc | activeSessions.createWebTicket | http.412');
    expect(second).not.toBe(first);
  });

  it('keeps the tRPC body in its payload context and no token in the fingerprint', () => {
    reportNetworkError({
      source: 'trpc',
      url: 'http://127.0.0.1:10416/api/trpc/session.list?input=%7B%22token%22%3A%22supersecret%22%7D',
      method: 'POST',
      durationMs: 5,
      error: {
        data: { code: 'UNAUTHORIZED', path: 'session.list', token: 'abcdefghijklmnopqrst' },
      },
    });

    const call = sentryMock.captureException.mock.calls[0];
    if (call === undefined) {
      throw new Error('expected one captured exception');
    }
    const [error, options] = call;
    const event = scrubCapture(error, options);
    const fingerprint = JSON.stringify(event.fingerprint);

    // The body reaches the event in its payload context — not under the
    // exception name `extraErrorDataIntegration` overwrites with `{}` — and
    // scrubEvent redacts the token inside it.
    expect(event.contexts?.[NETWORK_BODY_CONTEXT]).toEqual({
      data: { data: { code: 'UNAUTHORIZED', path: 'session.list', token: '[redacted]' } },
    });
    expect(JSON.stringify(event.contexts)).not.toContain('abcdefghijklmnopqrst');
    expect(fingerprint).not.toContain('abcdefghijklmnopqrst');
    expect(fingerprint).not.toContain('supersecret');
    expect(fingerprint).not.toContain('input=');
  });
});
