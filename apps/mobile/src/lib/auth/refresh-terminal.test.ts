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
import { bumpAuthEpoch, currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { performRefresh } from '@/lib/auth/credentials';
import {
  clearActiveToken,
  getAuthTokenForRequest,
  setActiveToken,
  setSignOutTeardownActive,
} from '@/lib/auth/token-owner';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from '@/lib/storage-keys';
import * as SecureStore from 'expo-secure-store';
/* eslint-enable import/first */

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

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
    // loop and clears, the second has no refresh token left to offer. A null
    // read is not proof of an absent session (a locked keychain answers null),
    // so the second attempt is an unreadable credential read, never a refusal:
    // it makes no request and the loop stays stopped.
    const first = await performRefresh();
    const second = await performRefresh();

    expect(first).toEqual({
      ok: false,
      refused: true,
      sessionVersion: currentAuthEpoch(),
    });
    expect(second).toEqual({
      ok: false,
      refused: false,
      unreadable: true,
      presentKeys: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.get(AUTH_TOKEN_KEY)).toBeUndefined();
    expect(store.get(REFRESH_TOKEN_KEY)).toBeUndefined();
    expect(store.get(TOKEN_EXPIRES_AT_KEY)).toBeUndefined();
    // The terminal failure is reported once, not once per attempt.
    expect(events).toHaveLength(1);
    expect(events[0]?.fingerprint).toEqual(['auth-terminal', '/api/auth/native/refresh', '401']);
  });

  it('keeps the in-memory owner serving after the 401 clear so sign-out cleanup can authenticate', async () => {
    store.set(AUTH_TOKEN_KEY, 'dead-token');
    store.set(REFRESH_TOKEN_KEY, 'dead-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '123');
    setActiveToken('dead-token', null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 })
    );

    const outcome = await performRefresh();

    expect(outcome).toEqual({
      ok: false,
      refused: true,
      sessionVersion: currentAuthEpoch(),
    });
    // The stored pair is gone, so the next refresh makes no request (it is an
    // unreadable credential read, not a refusal) and the loop is stopped...
    expect(store.get(REFRESH_TOKEN_KEY)).toBeUndefined();
    // ...but the in-memory owner must keep serving until sign-out's teardown
    // clears it: runLogoutCleanup's revoke/unregister run BEFORE the epoch
    // bump and read this same token for their Authorization header.
    await expect(getAuthTokenForRequest()).resolves.toBe('dead-token');
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

    expect(outcome).toEqual({
      ok: false,
      refused: true,
      sessionVersion: currentAuthEpoch(),
    });
    // A non-401 terminal refusal is not proof the credential is dead, so the
    // pair stays until sign-out clears it.
    expect(store.get(AUTH_TOKEN_KEY)).toBe('live-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('live-refresh');
  });

  it('still refuses and reports when the keychain delete rejects on a 401', async () => {
    store.set(AUTH_TOKEN_KEY, 'dead-token');
    store.set(REFRESH_TOKEN_KEY, 'dead-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '123');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 })
    );
    // The keychain rejects the first delete. The terminal refusal must survive
    // it: without the guard the rejection would reach doRefresh's catch, be
    // downgraded to a retryable outcome, and leave the dead pair in place so
    // every foreground retries the same 401.
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));
    const events = recordEvents();

    const outcome = await performRefresh();

    expect(outcome).toEqual({
      ok: false,
      refused: true,
      sessionVersion: currentAuthEpoch(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.fingerprint).toEqual(['auth-terminal', '/api/auth/native/refresh', '401']);
  });

  it('scopes a refusal to the session that owned it when the epoch moves mid-clear', async () => {
    store.set(AUTH_TOKEN_KEY, 'dead-token');
    store.set(REFRESH_TOKEN_KEY, 'dead-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 })
    );
    const { promise: clearGate, resolve: releaseClear } = Promise.withResolvers<undefined>();
    // Hold the first delete open so a newer session can land inside the clear.
    vi.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async (key: string) => {
      await clearGate;
      store.delete(key);
    });
    const ownedEpoch = currentAuthEpoch();

    const refresh = performRefresh();
    // Wait until the refresh reached the clear (the hanging delete) before
    // moving the epoch: that is the window where the refusal is still returned
    // even though the session that owned it is gone.
    let flushes = 0;
    while (vi.mocked(SecureStore.deleteItemAsync).mock.calls.length === 0 && flushes < 50) {
      flushes += 1;
      // eslint-disable-next-line no-await-in-loop -- sequential flush until the delete is in flight
      await flushMicrotasks();
    }
    expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
    bumpAuthEpoch();
    releaseClear(undefined);

    const outcome = await refresh;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.refused) {
      expect(outcome.sessionVersion).toBe(ownedEpoch);
    }
    // The handler's guard reads exactly this: the refusal is stale, so it must
    // not sign out the session that replaced it.
    expect(isCurrentAuthEpoch(ownedEpoch)).toBe(false);
  });
});
