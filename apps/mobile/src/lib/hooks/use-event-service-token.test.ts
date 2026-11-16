import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEventServiceTokenCache, useEventServiceTokenGetter } from './use-event-service-token';

const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn<() => Promise<string | null>>(),
  getTokenQuery: vi.fn<() => Promise<{ token: string; userId: string; expiresAt: string }>>(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: mocks.getAuthToken }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { kiloChat: { getToken: { query: mocks.getTokenQuery } } },
}));

const response = {
  token: 'event-token',
  userId: 'user-1',
  expiresAt: '2099-03-13 14:30:00+00',
};

describe('event-service authentication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearEventServiceTokenCache();
    mocks.getAuthToken.mockResolvedValue('auth-token-1');
    mocks.getTokenQuery.mockResolvedValue(response);
  });

  it('shares concurrent token requests and caches a PostgreSQL expiry', async () => {
    const getToken = useEventServiceTokenGetter();
    await expect(Promise.all([getToken(), getToken()])).resolves.toEqual([
      'event-token',
      'event-token',
    ]);
    await expect(getToken()).resolves.toBe('event-token');
    expect(mocks.getTokenQuery).toHaveBeenCalledTimes(1);
  });

  it('does not reuse another account token', async () => {
    const getToken = useEventServiceTokenGetter();
    await getToken();
    mocks.getAuthToken.mockResolvedValue('auth-token-2');
    mocks.getTokenQuery.mockResolvedValue({ ...response, token: 'second-token', userId: 'user-2' });
    await expect(getToken()).resolves.toBe('second-token');
    expect(mocks.getTokenQuery).toHaveBeenCalledTimes(2);
  });

  it('retries after failure and refreshes expired tokens', async () => {
    const getToken = useEventServiceTokenGetter();
    mocks.getTokenQuery.mockRejectedValueOnce(new Error('network down'));
    await expect(getToken()).rejects.toThrow('network down');
    mocks.getTokenQuery.mockResolvedValueOnce({ ...response, expiresAt: '2000-01-01 00:00:00+00' });
    await getToken();
    await expect(getToken()).resolves.toBe('event-token');
    expect(mocks.getTokenQuery).toHaveBeenCalledTimes(3);
  });

  it('rejects signed-out requests without contacting the server', async () => {
    mocks.getAuthToken.mockResolvedValue(null);
    await expect(useEventServiceTokenGetter()()).rejects.toThrow('not authenticated');
    expect(mocks.getTokenQuery).not.toHaveBeenCalled();
  });
});
