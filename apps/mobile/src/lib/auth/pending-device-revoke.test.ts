import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn((key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn((key: string) => {
    store.delete(key);
  }),
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.test',
}));

// Sentry's React Native build pulls in the RN runtime, which the node project
// cannot parse; the report path is spied here instead.
const sentryMock = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@sentry/react-native', () => sentryMock);

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
import {
  recordFailedDeviceSessionRevoke,
  recordPendingDeviceSessionRevoke,
  resetPendingDeviceRevokeForTests,
  retryPendingDeviceSessionRevoke,
} from '@/lib/auth/pending-device-revoke';
import { PENDING_DEVICE_REVOKE_KEY } from '@/lib/storage-keys';
/* eslint-enable import/first */

const DAY_MS = 24 * 60 * 60 * 1000;

const storedStoreSchema = z.object({
  version: z.literal(1),
  revokes: z.array(z.object({ refreshToken: z.string(), retryUntilMs: z.number() })),
});

/** The stored records, for assertions that never print a token. */
function storedRevokes(): { refreshToken: string; retryUntilMs: number }[] {
  const raw = store.get(PENDING_DEVICE_REVOKE_KEY);
  return raw === undefined ? [] : storedStoreSchema.parse(JSON.parse(raw)).revokes;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type CapturedRequest = { url: string; init: RequestInit };

describe('pending device-session revoke retry', () => {
  let requests: CapturedRequest[] = [];
  let fetchMock: Mock = vi.fn();
  /** Answers the next request; each test sets the answer it needs. */
  let answer: () => Promise<Response> = () => Promise.resolve(jsonResponse({ outcome: 'revoked' }));

  beforeEach(() => {
    store.clear();
    resetPendingDeviceRevokeForTests();
    requests = [];
    answer = () => Promise.resolve(jsonResponse({ outcome: 'revoked' }));
    fetchMock = vi.fn((url: string, init: RequestInit) => {
      requests.push({ url, init });
      return answer();
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPendingDeviceRevokeForTests();
  });

  it('records a failed revoke and clears it once the server revokes the session', async () => {
    await recordPendingDeviceSessionRevoke('old-refresh-token');

    expect(storedRevokes()).toEqual([
      { refreshToken: 'old-refresh-token', retryUntilMs: expect.any(Number) },
    ]);

    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({ kind: 'revoked' });

    // The recorded token is the credential, so it travels in the body — never a
    // bearer header, and never the current session's credential.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.test/api/auth/native/revoke');
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(requests[0]?.init.body).toBe(JSON.stringify({ refreshToken: 'old-refresh-token' }));

    // Nothing left to retry.
    expect(store.has(PENDING_DEVICE_REVOKE_KEY)).toBe(false);
  });

  it('treats an unknown token as terminal: the record is cleared and nothing is retried later', async () => {
    answer = () => Promise.resolve(jsonResponse({ outcome: 'unknown_token' }));

    await recordPendingDeviceSessionRevoke('consumed-refresh-token');

    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({
      kind: 'terminal',
      reason: 'unknown-token',
    });
    expect(store.has(PENDING_DEVICE_REVOKE_KEY)).toBe(false);

    // A later pass (a launch after the spacing window) never asks again.
    resetPendingDeviceRevokeForTests();
    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({ kind: 'none' });
    expect(requests).toHaveLength(1);
  });

  it('keeps the record when the route cannot settle it', async () => {
    answer = () => Promise.resolve(jsonResponse({ error: 'RETRY' }, 503));

    await recordPendingDeviceSessionRevoke('old-refresh-token');

    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({
      kind: 'retryable',
      reason: 'refused',
    });
    expect(storedRevokes()).toEqual([
      { refreshToken: 'old-refresh-token', retryUntilMs: expect.any(Number) },
    ]);
  });

  it('keeps the record when the request never reaches the server', async () => {
    answer = () => Promise.reject(new TypeError('Network request failed'));

    await recordPendingDeviceSessionRevoke('old-refresh-token');

    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({
      kind: 'retryable',
      reason: 'unreachable',
    });
    expect(storedRevokes()).toHaveLength(1);
  });

  it('runs one request for two triggers that arrive together', async () => {
    const gate = Promise.withResolvers<Response>();
    answer = () => gate.promise;
    await recordPendingDeviceSessionRevoke('old-refresh-token');

    const first = retryPendingDeviceSessionRevoke();
    const second = retryPendingDeviceSessionRevoke();
    gate.resolve(jsonResponse({ outcome: 'revoked' }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'revoked' },
      { kind: 'revoked' },
    ]);
    expect(requests).toHaveLength(1);
  });

  it('does not retry again inside the spacing window', async () => {
    answer = () => Promise.resolve(jsonResponse({ error: 'RETRY' }, 500));
    await recordPendingDeviceSessionRevoke('old-refresh-token');

    await retryPendingDeviceSessionRevoke();
    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({ kind: 'none' });

    expect(requests).toHaveLength(1);
  });

  it('drops a record whose retry window has passed without a request', async () => {
    store.set(
      PENDING_DEVICE_REVOKE_KEY,
      JSON.stringify({
        version: 1,
        revokes: [{ refreshToken: 'old-refresh-token', retryUntilMs: Date.now() - DAY_MS }],
      })
    );

    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({
      kind: 'terminal',
      reason: 'expired',
    });
    expect(requests).toHaveLength(0);
    expect(store.has(PENDING_DEVICE_REVOKE_KEY)).toBe(false);
  });

  it('keeps a record another sign-out wrote while the pass was in flight', async () => {
    const gate = Promise.withResolvers<Response>();
    answer = () => gate.promise;
    await recordPendingDeviceSessionRevoke('first-refresh-token');

    const pass = retryPendingDeviceSessionRevoke();
    await recordPendingDeviceSessionRevoke('second-refresh-token');
    gate.resolve(jsonResponse({ outcome: 'revoked' }));

    await expect(pass).resolves.toEqual({ kind: 'revoked' });
    expect(storedRevokes().map(revoke => revoke.refreshToken)).toEqual(['second-refresh-token']);
  });

  it('reports a failed revoke it cannot retry instead of storing a record', async () => {
    await recordFailedDeviceSessionRevoke(null);

    expect(store.has(PENDING_DEVICE_REVOKE_KEY)).toBe(false);
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      'Device session revoke could not be retried',
      expect.objectContaining({
        tags: expect.objectContaining({ 'error.operation': 'device_revoke_retry_unavailable' }),
      })
    );
  });

  it('never overwrites a payload it cannot decode', async () => {
    store.set(PENDING_DEVICE_REVOKE_KEY, '{"version":99,"revokes":[]}');

    await recordPendingDeviceSessionRevoke('old-refresh-token');

    expect(store.get(PENDING_DEVICE_REVOKE_KEY)).toBe('{"version":99,"revokes":[]}');
    await expect(retryPendingDeviceSessionRevoke()).resolves.toEqual({ kind: 'none' });
    expect(requests).toHaveLength(0);
  });
});
