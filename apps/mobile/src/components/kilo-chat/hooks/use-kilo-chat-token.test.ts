import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getItemAsync: vi.fn<() => Promise<string | null>>(),
  getTokenQuery: vi.fn<() => Promise<{ token: string; userId: string; expiresAt: string }>>(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
}));

vi.mock('@/lib/storage-keys', () => ({
  AUTH_TOKEN_KEY: 'auth-token',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    kiloChat: {
      getToken: {
        query: mocks.getTokenQuery,
      },
    },
  },
}));

describe('useKiloChatTokenResponseGetter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearKiloChatTokenCache } = await import('./use-kilo-chat-token');
    clearKiloChatTokenCache();
  });

  it('notifies subscribers after a later token fetch succeeds', async () => {
    const response = {
      token: 'kilo-jwt',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const seenUserIds: string[] = [];

    mocks.getItemAsync.mockResolvedValue('auth-token-1');
    mocks.getTokenQuery.mockRejectedValueOnce(new Error('network down'));
    mocks.getTokenQuery.mockResolvedValueOnce(response);

    const { subscribeToKiloChatTokenResponses, useKiloChatTokenResponseGetter } =
      await import('./use-kilo-chat-token');
    const unsubscribe = subscribeToKiloChatTokenResponses(tokenResponse => {
      seenUserIds.push(tokenResponse.userId);
    });
    const getTokenResponse = useKiloChatTokenResponseGetter();

    await expect(getTokenResponse()).rejects.toThrow('network down');
    expect(seenUserIds).toEqual([]);

    await expect(getTokenResponse()).resolves.toBe(response);
    expect(seenUserIds).toEqual(['user-1']);

    unsubscribe();
  });

  it('caches the token when a PostgreSQL-format expiry is far in the future', async () => {
    const response = {
      token: 'kilo-jwt',
      userId: 'user-2',
      expiresAt: '2099-03-13 14:30:00+00',
    };

    mocks.getItemAsync.mockResolvedValue('auth-token-2');
    mocks.getTokenQuery.mockResolvedValueOnce(response);

    const { useKiloChatTokenResponseGetter } = await import('./use-kilo-chat-token');
    const getTokenResponse = useKiloChatTokenResponseGetter();

    await expect(getTokenResponse()).resolves.toBe(response);
    await expect(getTokenResponse()).resolves.toBe(response);

    // A second call within the cache window must not re-fetch. This only
    // holds if the PG-format expiresAt was parsed into a valid future
    // timestamp — with the old `new Date(pgTimestamp)` behavior it parses to
    // an invalid Date (NaN), `expiresAtMs - Date.now() > 60_000` is false,
    // and this would refetch, failing this assertion.
    expect(mocks.getTokenQuery).toHaveBeenCalledTimes(1);
  });

  it('refetches when a PostgreSQL-format expiry is in the past', async () => {
    const firstResponse = {
      token: 'kilo-jwt-old',
      userId: 'user-3',
      expiresAt: '2000-01-01 00:00:00+00',
    };
    const secondResponse = {
      token: 'kilo-jwt-new',
      userId: 'user-3',
      expiresAt: '2099-03-13 14:30:00+00',
    };

    mocks.getItemAsync.mockResolvedValue('auth-token-3');
    mocks.getTokenQuery.mockResolvedValueOnce(firstResponse);
    mocks.getTokenQuery.mockResolvedValueOnce(secondResponse);

    const { useKiloChatTokenResponseGetter } = await import('./use-kilo-chat-token');
    const getTokenResponse = useKiloChatTokenResponseGetter();

    await expect(getTokenResponse()).resolves.toBe(firstResponse);
    await expect(getTokenResponse()).resolves.toBe(secondResponse);

    expect(mocks.getTokenQuery).toHaveBeenCalledTimes(2);
  });
});
