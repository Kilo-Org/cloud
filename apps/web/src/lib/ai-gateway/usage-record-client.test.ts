// Do not import `jest` from '@jest/globals' in this file. Doing so shadows the
// global `jest` that the SWC transform needs in order to hoist these
// `jest.mock` calls, and the mocks then silently fail to apply. The rest of the
// repository follows the same convention: import the assertion helpers only.
jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<object>('@/lib/config.server'),
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/constants', () => ({
  ...jest.requireActual<object>('@/lib/constants'),
  APP_URL: 'https://app.example.com',
}));

// The mock function is created inside the factory rather than captured from
// module scope: jest.mock is hoisted above const declarations, so referencing an
// outer const here throws "Cannot access before initialization" and silently
// leaves the real module in place. Retrieve it with jest.requireMock instead.
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import type * as SentryNextjs from '@sentry/nextjs';

import {
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  recordUsageInPrimaryRegion,
} from './usage-record-client';
import type { UsageRecordRequest } from './usage-record-contract';

const mockedCaptureException = jest.requireMock<typeof SentryNextjs>('@sentry/nextjs')
  .captureException as unknown as jest.Mock;

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Deliberately not faking timers or stubbing setTimeout here. The shared Jest
// worker setup opens a real pg pool, and pg-pool arms its connection timeout with
// setTimeout — a global stub that invokes callbacks synchronously fires that
// timeout immediately and closes the client. The client's real backoff is a few
// hundred milliseconds, which is cheap enough to just wait out.

const payload = {
  core: { id: 'usage-1' },
  metadata: {},
  prior_microdollar_usage: 0,
  posthog_distinct_id: null,
} as unknown as UsageRecordRequest;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const recorded = {
  status: 'recorded',
  result: { usageId: 'usage-1', createdAt: '2026-08-05T10:11:12.945Z', newMicrodollarsUsed: 42 },
};

beforeEach(() => {
  mockFetch.mockReset();
  mockedCaptureException.mockClear();
});

describe('recordUsageInPrimaryRegion', () => {
  test('posts to the Frankfurt endpoint with the internal secret', async () => {
    mockFetch.mockResolvedValue(jsonResponse(recorded));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'ok', result: recorded.result });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.example.com/api/internal/usage/record');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-internal-api-key']).toBe(
      'test-internal-secret'
    );
  });

  test('treats a duplicate as success so a redelivered write is not reported as lost', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        status: 'duplicate',
        result: {
          usageId: 'usage-1',
          createdAt: '2026-08-05T10:11:12.945Z',
          newMicrodollarsUsed: null,
        },
      })
    );

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome.kind).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('propagates a deliberate not_recorded outcome without retrying', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'not_recorded', result: null }));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'ok', result: null });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // 429/502/503 are refusals: the function provably did not run, so re-sending
  // cannot produce a second write.
  test.each([429, 502, 503])('retries a %i refusal and succeeds', async status => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, status))
      .mockResolvedValueOnce(jsonResponse(recorded));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome.kind).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // A 500 means our handler threw, possibly after the transaction committed. This
  // was the dominant source of primary-key collisions, so it must not retry.
  test.each([500, 504])('does not retry an ambiguous %i', async status => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, status));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'unavailable', reason: `http_${status}` });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // The regression this branch exists to prevent: a 10s timeout against a p95 of
  // ~50s meant roughly 20% of deliveries were re-sent with the same core.id.
  test('never retries a timeout, because the write may still be in flight', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    mockFetch.mockRejectedValue(timeout);

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'TimeoutError' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Guards the invariant the incident violated: the attempt budget has to clear the
  // endpoint's tail, and stay inside its maxDuration of 150s.
  test('keeps the attempt timeout above the observed p95 and below maxDuration', () => {
    expect(ATTEMPT_TIMEOUT_MS).toBeGreaterThan(50_000);
    expect(ATTEMPT_TIMEOUT_MS).toBeLessThan(150_000);
  });

  test('retries a network failure and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse(recorded));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome.kind).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('does not retry a 400, because the payload cannot become valid', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Invalid body' }, 400));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'http_400' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('does not retry a 401', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'http_401' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('stops after the attempt cap and reports unavailable', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome.kind).toBe('unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
  });

  // A malformed response may mean the write committed, so retrying risks nothing
  // (the receiver dedupes) but is pointless; the caller must reconcile instead.
  test('does not retry a malformed response body', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'nonsense' }));

    const outcome = await recordUsageInPrimaryRegion(payload);

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'malformed_response' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('reports the failure to Sentry with the usage id for reconciliation', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

    await recordUsageInPrimaryRegion(payload);

    const [, options] = mockedCaptureException.mock.calls[0] as [
      unknown,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(options.tags.source).toBe('recordUsageInPrimaryRegion');
    expect(options.extra.usageId).toBe('usage-1');
  });
});
