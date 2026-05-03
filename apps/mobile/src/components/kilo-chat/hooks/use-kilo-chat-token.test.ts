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
});
