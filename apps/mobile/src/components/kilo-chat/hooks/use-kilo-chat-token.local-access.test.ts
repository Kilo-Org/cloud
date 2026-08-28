import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  clearKiloChatTokenCache,
  subscribeToKiloChatTokenResponses,
  useKiloChatTokenResponseGetter,
} from './use-kilo-chat-token';

const mocks = vi.hoisted(() => ({
  authToken: vi.fn<() => Promise<string | null>>(),
  query: vi.fn<() => Promise<{ userId: string; token: string; expiresAt: string }>>(),
}));
vi.mock('react', () => ({ useCallback: <T>(fn: T) => fn }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: mocks.authToken }));
vi.mock('@/lib/trpc', () => ({ trpcClient: { kiloChat: { getToken: { query: mocks.query } } } }));
vi.mock('@/lib/utils', () => ({ parseTimestamp: (value: string) => new Date(value) }));

function replaceOwner(userId: string) {
  bumpAuthEpoch();
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), userId);
  return getAuthenticatedOwner();
}
function response(userId: string, token = `chat-${userId}`) {
  return { userId, token, expiresAt: '2099-01-01T00:00:00Z' };
}
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  clearKiloChatTokenCache();
  mocks.authToken.mockResolvedValue('credential');
  replaceOwner('a');
});
afterEach(() => {
  for (const off of cleanups.splice(0)) {
    off();
  }
});

describe('chat token original ownership', () => {
  it('rejects A after direct replacement and publishes only B to subscribers', async () => {
    const old = Promise.withResolvers<ReturnType<typeof response>>();
    const entered = Promise.withResolvers<undefined>();
    mocks.query.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      const result = await old.promise;
      return result;
    });
    const seen: string[] = [];
    cleanups.push(
      subscribeToKiloChatTokenResponses(value => {
        seen.push(value.userId);
      })
    );
    const getA = useKiloChatTokenResponseGetter(getAuthenticatedOwner());
    const pending = getA();
    await entered.promise;
    const ownerB = replaceOwner('b');
    mocks.query.mockResolvedValue(response('b'));
    const getB = useKiloChatTokenResponseGetter(ownerB);
    await expect(getB()).resolves.toMatchObject({ token: 'chat-b' });
    old.resolve(response('a'));
    await expect(pending).rejects.toMatchObject({ code: 'LOCAL_ACCESS_DENIED', reason: 'owner' });
    await expect(getA()).rejects.toMatchObject({ reason: 'owner' });
    await expect(getB()).resolves.toMatchObject({ token: 'chat-b' });
    expect(seen).toEqual(['b']);
  });

  it('fences the credential wait before token minting starts', async () => {
    const credential = Promise.withResolvers<string>();
    mocks.authToken.mockReturnValueOnce(credential.promise);
    mocks.query.mockResolvedValue(response('b'));
    const pending = useKiloChatTokenResponseGetter(getAuthenticatedOwner())();
    replaceOwner('b');
    credential.resolve('old-credential');
    await expect(pending).rejects.toMatchObject({ reason: 'owner' });
    expect(mocks.query.mock.calls).toEqual([]);
  });

  it('does not repopulate a cleared cache from the pre-retry token request', async () => {
    const old = Promise.withResolvers<ReturnType<typeof response>>();
    const entered = Promise.withResolvers<undefined>();
    mocks.query.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      const result = await old.promise;
      return result;
    });
    const getter = useKiloChatTokenResponseGetter(getAuthenticatedOwner());
    const pending = getter();
    await entered.promise;
    clearKiloChatTokenCache();
    mocks.query.mockResolvedValue(response('a', 'fresh'));
    await expect(getter()).resolves.toMatchObject({ token: 'fresh' });
    old.resolve(response('a', 'stale'));
    await expect(pending).rejects.toMatchObject({ reason: 'stale' });
    await expect(getter()).resolves.toMatchObject({ token: 'fresh' });
  });

  it('rejects a token response whose user differs from the authenticated owner', async () => {
    mocks.query.mockResolvedValueOnce(response('b')).mockResolvedValueOnce(response('a'));
    const seen: string[] = [];
    cleanups.push(
      subscribeToKiloChatTokenResponses(value => {
        seen.push(value.userId);
      })
    );
    const getter = useKiloChatTokenResponseGetter(getAuthenticatedOwner());
    await expect(getter()).rejects.toMatchObject({ reason: 'owner' });
    await expect(getter()).resolves.toMatchObject({ userId: 'a' });
    expect(seen).toEqual(['a']);
  });

  it('keeps the manual retry admission through a delayed credential read', async () => {
    let generation = 0;
    const admitted = generation;
    const credential = Promise.withResolvers<string>();
    mocks.authToken.mockReturnValueOnce(credential.promise);
    const pending = useKiloChatTokenResponseGetter(getAuthenticatedOwner())(() => {
      if (admitted !== generation) {
        throw new Error('stale retry');
      }
    });
    generation += 1;
    credential.resolve('credential');
    await expect(pending).rejects.toThrow('stale retry');
    expect(mocks.query.mock.calls).toEqual([]);
  });
});
