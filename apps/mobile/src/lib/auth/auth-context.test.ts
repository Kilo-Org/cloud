import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
vi.mock('expo-secure-store', () => ({
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

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
}));

vi.mock('@/lib/analytics/posthog', () => ({
  resetAnalyticsUser: vi.fn(),
}));

vi.mock('@/lib/appsflyer', () => ({
  trackEvent: vi.fn(),
}));

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
/* eslint-enable import/first */

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
  });

  it('clears a prior refresh pair for a token-only sign-in', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '999999');

    await persistSignInCredentials('token-only');

    expect(store.get(AUTH_TOKEN_KEY)).toBe('token-only');
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
  });
});

describe('exchangeLegacyToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
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

  it('returns null on network error and does not set the done marker', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Offline'));

    const result = await exchangeLegacyToken();
    expect(result).toBeNull();
    expect(store.get(LEGACY_EXCHANGE_DONE_KEY)).toBeUndefined();
    expect(store.get(AUTH_TOKEN_KEY)).toBe('old-token');
  });
});
