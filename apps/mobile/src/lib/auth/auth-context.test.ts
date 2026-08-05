/* eslint-disable max-lines -- one cohesive auth-context suite: refresh, sign-in, and epoch-fence cases share the SecureStore mock and the serialized-write seam */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

// Lets tests hold credential writes open at the SecureStore boundary so the
// epoch fence can be exercised both while a write is queued and mid-write.
let heldWrites: Promise<void> | null = null;
let releaseHeldWrites: (() => void) | null = null;

function holdCredentialWrites(): void {
  heldWrites = new Promise<void>(resolve => {
    releaseHeldWrites = resolve;
  });
}

function releaseCredentialWrites(): void {
  releaseHeldWrites?.();
  heldWrites = null;
  releaseHeldWrites = null;
}

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    if (heldWrites) {
      await heldWrites;
    }
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
}));

vi.mock('@/lib/analytics/posthog', () => ({
  discardPostHog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/appsflyer', () => ({ resetAppsFlyerState: vi.fn(), trackEvent: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ setUser: vi.fn() }));
vi.mock('@/lib/telemetry/controller', () => ({ clearTelemetryDecision: vi.fn() }));
vi.mock('@/lib/telemetry/posthog-storage', () => ({ purgePostHogPersistence: vi.fn() }));
// sonner-native pulls in react-native at runtime, whose Flow-only `import
// typeof` syntax crashes Node's parser in the pure (node) test environment.
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  clearAgentModelPreference: vi.fn(),
}));

vi.mock('@/lib/hooks/use-reasoning-preference', () => ({
  clearReasoningPreference: vi.fn(),
}));

vi.mock('@/lib/last-active-instance', () => ({
  clearLastActiveInstance: vi.fn(),
}));

vi.mock('@/lib/kilo-pass/use-store-kilo-pass-purchase', () => ({
  resetPurchaseErrorToastDedup: vi.fn(),
}));

vi.mock('@/lib/pr-review/recent-prs', () => ({
  clearRecentPrs: vi.fn(),
}));

vi.mock('@/lib/pr-review/viewed-files', () => ({
  clearViewedFiles: vi.fn(),
}));

vi.mock('@/lib/query-client', () => ({
  queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

import {
  exchangeLegacyToken,
  invalidateRefreshSession,
  persistSignInCredentials,
  performRefresh,
} from '@/lib/auth/auth-context';
import {
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';
import { clearActiveToken, getActiveToken } from '@/lib/auth/token-owner';
import * as SecureStore from 'expo-secure-store';
/* eslint-enable import/first */

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

describe('performRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    invalidateRefreshSession();
  });

  it('returns refused when no refresh token is stored', async () => {
    const outcome = await performRefresh();
    expect(outcome).toEqual({ ok: false, refused: true });
  });

  it('returns refused when the server responds with 401', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'invalid' }, { status: 401 })
    );

    const outcome = await performRefresh();
    expect(outcome).toEqual({ ok: false, refused: true });
  });

  it('returns transient when the server responds with a non-401 error', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('server error', { status: 500 })
    );

    const outcome = await performRefresh();
    expect(outcome).toEqual({ ok: false, refused: false });
  });

  it('returns transient when the response body fails validation (missing fields)', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ token: 'new-token' }, { status: 200 })
    );

    const outcome = await performRefresh();
    expect(outcome).toEqual({ ok: false, refused: false });
    // Must not write partial data.
    expect(store.get(AUTH_TOKEN_KEY)).toBeUndefined();
  });

  it('returns transient when the response body is not valid JSON', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not json', { status: 200 }));

    const outcome = await performRefresh();
    expect(outcome).toEqual({ ok: false, refused: false });
  });

  it('returns success and persists the new token pair on valid response', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { token: 'new-token', refreshToken: 'new-refresh', expiresIn: 3600 },
        {
          status: 200,
        }
      )
    );

    const before = Date.now();
    const outcome = await performRefresh();
    const after = Date.now();

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.token).toBe('new-token');
      expect(outcome.refreshToken).toBe('new-refresh');
      expect(outcome.expiresIn).toBe(3600);
    }

    expect(store.get(AUTH_TOKEN_KEY)).toBe('new-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('new-refresh');
    const expiresAt = Number(store.get(TOKEN_EXPIRES_AT_KEY));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it('returns transient on network error', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const outcome = await performRefresh();
    expect(outcome).toEqual({ ok: false, refused: false });
    // Old credentials are untouched.
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('old-refresh');
  });

  it('single-flights concurrent refresh calls', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { token: 'shared', refreshToken: 'shared-ref', expiresIn: 3600 },
          { status: 200 }
        )
      );

    // Start two concurrent refresh calls.
    const p1 = performRefresh();
    const p2 = performRefresh();

    const [outcome1, outcome2] = await Promise.all([p1, p2]);

    // Must be the same outcome — single-flight.
    expect(outcome1).toEqual(outcome2);
    if (outcome1.ok) {
      expect(outcome1.token).toBe('shared');
    }
    // fetch must be called exactly once.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not restore credentials after sign-out invalidates a refresh', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    let resolveResponse = undefined as ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        resolve();
      });
      return new Promise<Response>(resolve => {
        resolveResponse = resolve;
      });
    });

    const refresh = performRefresh();
    await vi.waitFor(() => {
      expect(resolveResponse).toBeTypeOf('function');
    });
    invalidateRefreshSession();
    resolveResponse?.(
      Response.json({ token: 'new-token', refreshToken: 'new-refresh', expiresIn: 3600 })
    );

    expect(await refresh).toEqual({ ok: false, refused: false, superseded: true });
    expect(store.get(AUTH_TOKEN_KEY)).toBeUndefined();
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('old-refresh');
  });

  it('does not overwrite a newer sign-in when refresh completes later', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    let resolveResponse = undefined as ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        resolve();
      });
      return new Promise<Response>(resolve => {
        resolveResponse = resolve;
      });
    });

    const refresh = performRefresh();
    await vi.waitFor(() => {
      expect(resolveResponse).toBeTypeOf('function');
    });
    invalidateRefreshSession();
    store.set(AUTH_TOKEN_KEY, 'newer-token');
    store.set(REFRESH_TOKEN_KEY, 'newer-refresh');
    resolveResponse?.(
      Response.json({ token: 'old-token', refreshToken: 'old-refresh-2', expiresIn: 3600 })
    );

    expect(await refresh).toEqual({ ok: false, refused: false, superseded: true });
    expect(store.get(AUTH_TOKEN_KEY)).toBe('newer-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('newer-refresh');
  });

  it('does not refuse a newer session after an old refresh receives 401', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    let resolveResponse = undefined as ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        resolve();
      });
      return new Promise<Response>(resolve => {
        resolveResponse = resolve;
      });
    });

    const refresh = performRefresh();
    await vi.waitFor(() => {
      expect(resolveResponse).toBeTypeOf('function');
    });
    invalidateRefreshSession();
    store.set(REFRESH_TOKEN_KEY, 'newer-refresh');
    resolveResponse?.(Response.json({ error: 'expired' }, { status: 401 }));

    expect(await refresh).toEqual({ ok: false, refused: false, superseded: true });
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('newer-refresh');
  });
});

describe('persistSignInCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    releaseCredentialWrites();
    clearActiveToken();
  });

  it('clears a prior refresh pair for a token-only sign-in', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '999999');

    const published = await persistSignInCredentials('token-only');

    expect(published).toBe(true);
    expect(store.get(AUTH_TOKEN_KEY)).toBe('token-only');
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
  });

  it('returns true and publishes the pair when the epoch is unchanged', async () => {
    const published = await persistSignInCredentials('new-token', 'new-refresh', 3600);

    expect(published).toBe(true);
    expect(store.get(AUTH_TOKEN_KEY)).toBe('new-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('new-refresh');
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(true);
    expect(getActiveToken()).toEqual({ token: 'new-token', expiresAtMs: expect.any(Number) });
  });

  it('does not publish a sign-in queued behind a write when the epoch moves', async () => {
    // Hold the serialized credential write open at the SecureStore boundary.
    holdCredentialWrites();

    const first = persistSignInCredentials('first-token', 'first-refresh', 3600);
    // Queued behind the first write; both captured the still-current epoch.
    const stale = persistSignInCredentials('stale-token', 'stale-refresh', 3600);

    // A concurrent sign-in or sign-out bumps the epoch before either write ran.
    invalidateRefreshSession();

    releaseCredentialWrites();
    const [firstResult, staleResult] = await Promise.all([first, stale]);

    // Neither superseded write published anything.
    expect(firstResult).toBe(false);
    expect(staleResult).toBe(false);
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    expect(getActiveToken()).toBeNull();
  });

  it('does not publish the refresh pair or an active token when the epoch moves mid-write', async () => {
    holdCredentialWrites();

    const pending = persistSignInCredentials('mid-token', 'mid-refresh', 3600);
    // Let the write start and block at the SecureStore boundary, then bump.
    await flushMicrotasks();
    invalidateRefreshSession();
    releaseCredentialWrites();
    const published = await pending;

    // The in-flight AUTH_TOKEN write had already committed, but the stale
    // write cleared the partial pair it left behind and published nothing.
    expect(published).toBe(false);
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    expect(getActiveToken()).toBeNull();
  });

  it('does not publish a refresh pair when the epoch moves during refresh persistence', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    holdCredentialWrites();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ token: 'refreshed', refreshToken: 'new-refresh', expiresIn: 3600 })
    );

    const refresh = performRefresh();
    await flushMicrotasks();
    invalidateRefreshSession();
    releaseCredentialWrites();

    const result = await refresh;
    expect(result).toEqual({ ok: false, refused: false, superseded: true });
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    expect(getActiveToken()).toBeNull();
  });
});

describe('exchangeLegacyToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    releaseCredentialWrites();
  });

  it('returns null when the exchange marker is already set', async () => {
    store.set(LEGACY_EXCHANGE_DONE_KEY, '1');

    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
  });

  it('returns null when no auth token is stored', async () => {
    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
  });

  it('returns null on non-ok response and does not set the done marker', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('gone', { status: 410 }));

    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
    // Must not set the done marker — retry on next launch.
    expect(store.get(LEGACY_EXCHANGE_DONE_KEY)).toBeUndefined();
  });

  it('returns null when response body fails validation', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ token: 'short' }, { status: 200 })
    );

    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
    // Old token is retained.
    expect(store.get(AUTH_TOKEN_KEY)).toBe('old-token');
    expect(store.get(LEGACY_EXCHANGE_DONE_KEY)).toBeUndefined();
  });

  it('returns the new pair and sets the done marker on success', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { token: 'exchanged', refreshToken: 'exchanged-ref', expiresIn: 7200 },
        { status: 200 }
      )
    );

    const result = await exchangeLegacyToken();
    expect(result).toEqual({
      token: 'exchanged',
      refreshToken: 'exchanged-ref',
      expiresIn: 7200,
    });
    expect(store.get(AUTH_TOKEN_KEY)).toBe('exchanged');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('exchanged-ref');
    expect(store.get(LEGACY_EXCHANGE_DONE_KEY)).toBe('1');
  });

  it('returns null and does not set the done marker when the exchange write is fenced', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { token: 'exchanged', refreshToken: 'exchanged-ref', expiresIn: 7200 },
        { status: 200 }
      )
    );
    // Hold the serialized credential write open at the SecureStore boundary.
    holdCredentialWrites();

    const exchange = exchangeLegacyToken();
    // Let the exchange pass its pre-persist epoch check and block at the
    // fenced AUTH_TOKEN write, then supersede it.
    await vi.waitFor(() => {
      expect(vi.mocked(SecureStore.setItemAsync)).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 'exchanged');
    });
    invalidateRefreshSession();
    releaseCredentialWrites();

    const result = await exchange;
    // The stale exchange stops before the completion marker and the success
    // result, and the fenced persist cleared the partial pair it committed.
    expect(result).toBeNull();
    expect(store.get(LEGACY_EXCHANGE_DONE_KEY)).toBeUndefined();
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
  });

  it('does not send a stale pre-sign-out token or persist its result when the epoch moves during the bootstrap reads', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    // A persistent rejection (not a one-shot mock) so an unconsumed
    // implementation cannot leak into the next test when the epoch fence
    // correctly prevents the fetch.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch must not be called'));

    // Hold the legacy-token read open with a pre-sign-out snapshot so a
    // sign-out can land before the read completes.
    let releaseRead = undefined as (() => void) | undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    vi.mocked(SecureStore.getItemAsync)
      .mockImplementationOnce(async (key: string) => {
        // Marker read: completes normally.
        await Promise.resolve();
        return store.get(key) ?? null;
      })
      .mockImplementationOnce(async (key: string) => {
        // Legacy-token read: snapshot the token, then hold open.
        const snapshot = store.get(key) ?? null;
        await readGate;
        await Promise.resolve();
        return snapshot;
      });

    const exchange = exchangeLegacyToken();
    // Let the exchange pass the marker read and block on the held token read.
    await flushMicrotasks();
    // Sign out while the read is in flight: the epoch bumps and every
    // credential key is cleared.
    invalidateRefreshSession();
    store.delete(AUTH_TOKEN_KEY);
    store.delete(REFRESH_TOKEN_KEY);
    store.delete(TOKEN_EXPIRES_AT_KEY);
    releaseRead?.();

    const result = await exchange;
    // The stale pre-sign-out token was never sent and nothing was persisted.
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    expect(store.has(LEGACY_EXCHANGE_DONE_KEY)).toBe(false);
  });

  it('clears the done marker when the epoch moves during marker persistence', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ token: 'exchanged', refreshToken: 'exchanged-ref', expiresIn: 7200 })
    );
    for (let index = 0; index < 3; index += 1) {
      vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
        store.set(key, value);
        await Promise.resolve();
      });
    }
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      store.set(key, value);
      invalidateRefreshSession();
      await Promise.resolve();
    });

    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
    expect(store.has(LEGACY_EXCHANGE_DONE_KEY)).toBe(false);
  });

  it('returns null on network error and does not set the done marker', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Offline'));

    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
    expect(store.get(LEGACY_EXCHANGE_DONE_KEY)).toBeUndefined();
    expect(store.get(AUTH_TOKEN_KEY)).toBe('old-token');
  });
});
