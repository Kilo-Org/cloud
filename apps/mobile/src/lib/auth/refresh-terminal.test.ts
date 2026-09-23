import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves. This suite
// exercises only the refresh rotation, so the sign-out teardown graph that
// credentials.test.ts has to stub is never loaded here.
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

// `@/lib/config` is stubbed once for the whole pure project by vitest.setup.ts
// (its real module needs the baked `extra`), exactly as credentials.test.ts
// relies on it.

import { resetAuthTerminalReports } from '@/lib/auth/auth-response-class';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { performRefresh } from '@/lib/auth/credentials';
import { clearActiveToken, setSignOutTeardownActive } from '@/lib/auth/token-owner';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from '@/lib/storage-keys';
/* eslint-enable import/first */

function recordEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  setTelemetrySink(event => {
    events.push(event);
  });
  return events;
}

describe('refresh terminal classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    clearActiveToken();
    setSignOutTeardownActive(false);
    bumpAuthEpoch();
  });

  afterEach(() => {
    setTelemetrySink(null);
    resetAuthTerminalReports();
    vi.unstubAllGlobals();
  });

  it('clears the stored pair and reports once when the server answers 401', async () => {
    store.set(AUTH_TOKEN_KEY, 'dead-token');
    store.set(REFRESH_TOKEN_KEY, 'dead-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '123');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 }));
    const events = recordEvents();

    // Two foregrounds against the same dead credential: the first stops the
    // loop and clears, the second has no refresh token left to offer.
    const first = await performRefresh();
    const second = await performRefresh();

    expect(first).toEqual({ ok: false, refused: true });
    expect(second).toEqual({ ok: false, refused: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.get(AUTH_TOKEN_KEY)).toBeUndefined();
    expect(store.get(REFRESH_TOKEN_KEY)).toBeUndefined();
    expect(store.get(TOKEN_EXPIRES_AT_KEY)).toBeUndefined();
    // The terminal failure is reported once, not once per attempt.
    expect(events).toHaveLength(1);
    expect(events[0]?.fingerprint).toEqual(['auth-terminal', '/api/auth/native/refresh', '401']);
  });

  it('keeps a 429 transient, carries Retry-After, and keeps the pair', async () => {
    store.set(AUTH_TOKEN_KEY, 'live-token');
    store.set(REFRESH_TOKEN_KEY, 'live-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { error: 'TOO_MANY_ATTEMPTS' },
        { status: 429, headers: { 'retry-after': '9' } }
      )
    );

    const outcome = await performRefresh();

    expect(outcome).toEqual({ ok: false, refused: false, retryAfterMs: 9000 });
    expect(store.get(AUTH_TOKEN_KEY)).toBe('live-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('live-refresh');
  });

  it('stops on a 4xx with no retry guidance instead of retrying it', async () => {
    store.set(AUTH_TOKEN_KEY, 'live-token');
    store.set(REFRESH_TOKEN_KEY, 'live-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad request', { status: 400 }));

    const outcome = await performRefresh();

    expect(outcome).toEqual({ ok: false, refused: true });
    // A non-401 terminal refusal is not proof the credential is dead, so the
    // pair stays until sign-out clears it.
    expect(store.get(AUTH_TOKEN_KEY)).toBe('live-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('live-refresh');
  });
});
