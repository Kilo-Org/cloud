/* eslint-disable max-lines -- real tRPC delegates share one controlled credential and fetch harness */
import { getUntypedClient } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  values: new Map<string, string>(),
  tokenWait: null as Promise<undefined> | null,
  expiryWait: null as Promise<undefined> | null,
  getItemAsync: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
const latency = vi.hoisted(() => ({ messages: 0, session: 0 }));
vi.mock('expo-secure-store', () => ({ getItemAsync: secureStore.getItemAsync }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  get E2E_LATENCY_MESSAGES_MS() {
    return latency.messages;
  },
  get E2E_LATENCY_SESSION_MS() {
    return latency.session;
  },
}));
vi.mock('@/lib/storage-keys', () => ({
  AUTH_TOKEN_KEY: 'auth-token',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
}));
vi.mock('@/lib/auth/credentials', () => ({ performRefresh: refresh, REFRESH_MARGIN_MS: 60_000 }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.4' }));

const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let stop: (() => void) | undefined = undefined;
function firstRequest() {
  const first = fetchMock.mock.calls.at(0);
  if (!first) {
    throw new Error('No native dispatch');
  }
  return first;
}
function urlString(url: RequestInfo | URL) {
  return url instanceof Request ? url.url : url.toString();
}
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}
beforeEach(() => {
  vi.useRealTimers();
  latency.messages = 0;
  latency.session = 0;
  secureStore.values.clear();
  secureStore.tokenWait = null;
  secureStore.expiryWait = null;
  secureStore.getItemAsync.mockReset().mockImplementation(async (key: string) => {
    if (key === 'auth-token') {
      await secureStore.tokenWait;
    }
    if (key === 'token-expires-at') {
      await secureStore.expiryWait;
    }
    return secureStore.values.get(key) ?? null;
  });
  refresh.mockReset().mockResolvedValue({ ok: false, refused: false });
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    const source = new Headers(init?.headers).get('authorization');
    const address = urlString(url);
    const path = address.split('/api/trpc/')[1]?.split('?')[0] ?? '';
    const response = { result: { data: { source } } };
    await Promise.resolve();
    return Response.json(
      address.includes('batch=1') ? path.split(',').map(() => response) : response
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setup(enabled = false) {
  const owners = await import('@/lib/context-scope');
  const epoch = await import('@/lib/auth/auth-epoch');
  const access = await import('@/lib/local-access');
  const tokens = await import('@/lib/auth/token-owner');
  owners.confirmAuthenticatedOwner(owners.beginAuthenticatedOwner(), 'A');
  stop = access.initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'present', enabled }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => () => undefined },
  });
  await access.setLocalAccessOwner('A', epoch.currentAuthEpoch());
  access.setLocalAccessContextReady(true);
  await access.requestLocalAccess('unlock', true);
  const module = await import('./trpc');
  return {
    client: getUntypedClient(module.trpcClient),
    deadlineFetch: module.deadlineFetch,
    access,
    owners,
    epoch,
    tokens,
    replace() {
      epoch.bumpAuthEpoch();
      owners.confirmAuthenticatedOwner(owners.beginAuthenticatedOwner(), 'B');
      tokens.setActiveToken('token-B', Date.now() + 3_600_000);
    },
  };
}
const denied = { cause: { code: 'LOCAL_ACCESS_DENIED' } };
async function waitForExpiry() {
  await vi.waitFor(() => {
    expect(secureStore.getItemAsync).toHaveBeenCalledWith('token-expires-at');
  });
}

describe('operation-scoped tRPC transport', () => {
  it.each([false, true])(
    'preserves POST, metadata, input, and output with skipBatch=%s',
    async skipBatch => {
      const h = await setup();
      h.tokens.setActiveToken('token-A', Date.now() + 3_600_000);
      await expect(
        h.client.query('user.getMe', { marker: 'input' }, { context: { skipBatch } })
      ).resolves.toEqual({ source: 'Bearer token-A' });
      const [url, init] = firstRequest();
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('x-kilo-client')).toBe('mobile');
      expect(new Headers(init?.headers).get('x-kilo-app-platform')).toBe('ios');
      expect(new Headers(init?.headers).get('x-kilo-app-version')).toBe('1.0.4');
      expect(JSON.parse(init?.body as string)).toEqual(
        skipBatch ? { marker: 'input' } : { '0': { marker: 'input' } }
      );
      expect(urlString(url).includes('batch=1')).toBe(!skipBatch);
    }
  );

  it('warms cold token and expiry once without changing the wire headers', async () => {
    const h = await setup();
    secureStore.values.set('auth-token', 'stored-token');
    secureStore.values.set('token-expires-at', String(Date.now() + 3_600_000));
    await expect(h.client.query('user.getMe')).resolves.toEqual({ source: 'Bearer stored-token' });
    await expect(h.client.query('organizations.list')).resolves.toEqual({
      source: 'Bearer stored-token',
    });
    expect(secureStore.getItemAsync.mock.calls).toEqual([['auth-token'], ['token-expires-at']]);
  });

  it('uses a same-generation token rotation without overwriting its expiry', async () => {
    const h = await setup();
    secureStore.values.set('auth-token', 'stored-token');
    secureStore.values.set('token-expires-at', String(Date.now() - 1000));
    const wait = Promise.withResolvers<undefined>();
    secureStore.expiryWait = wait.promise;
    const pending = h.client.query('user.getMe');
    await waitForExpiry();
    h.tokens.setActiveToken('rotated-A', Date.now() + 3_600_000);
    wait.resolve(undefined);
    await expect(pending).resolves.toEqual({ source: 'Bearer rotated-A' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token within its captured credential generation', async () => {
    const h = await setup();
    h.tokens.setActiveToken('old-A', Date.now() - 1000);
    refresh.mockImplementation(async () => {
      h.tokens.setActiveToken('refreshed-A', Date.now() + 3_600_000);
      await Promise.resolve();
      return { ok: true };
    });
    await expect(h.client.query('user.getMe')).resolves.toEqual({ source: 'Bearer refreshed-A' });
  });

  it.each(['token', 'expiry', 'refresh'] as const)(
    'rejects account replacement during the %s wait',
    async stage => {
      const h = await setup();
      const wait = Promise.withResolvers<undefined>();
      if (stage === 'token') {
        secureStore.tokenWait = wait.promise;
      } else if (stage === 'expiry') {
        h.tokens.setActiveToken('token-A', null);
        secureStore.expiryWait = wait.promise;
      } else {
        h.tokens.setActiveToken('token-A', 1);
        refresh.mockReturnValue(wait.promise);
      }
      const pending = outcome(h.client.query('user.getMe'));
      await vi.waitFor(() => {
        expect(stage === 'refresh' ? refresh : secureStore.getItemAsync).toHaveBeenCalled();
      });
      h.replace();
      wait.resolve(undefined);
      expect(await pending).toMatchObject(denied);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('batches ordinary reads but isolates overlapping credential generations', async () => {
    const h = await setup();
    h.tokens.setActiveToken('token-A', Date.now() + 3_600_000);
    const first = await Promise.all([
      h.client.query('user.getMe'),
      h.client.query('organizations.list'),
    ]);
    expect(first).toEqual([{ source: 'Bearer token-A' }, { source: 'Bearer token-A' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const old = outcome(h.client.query('user.getMe'));
    h.replace();
    const replacement = h.client.query('organizations.list');
    expect(await old).toMatchObject(denied);
    await expect(replacement).resolves.toEqual({ source: 'Bearer token-B' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps an uncancelled query alive when its batch sibling is cancelled', async () => {
    const h = await setup();
    h.tokens.setActiveToken('token-A', Date.now() + 3_600_000);
    const controller = new AbortController();
    const cancelled = outcome(
      h.client.query('user.getMe', undefined, { signal: controller.signal })
    );
    const active = h.client.query('organizations.list');
    controller.abort(new Error('cancelled query'));
    await cancelled;
    await expect(active).resolves.toEqual({ source: 'Bearer token-A' });
  });

  it('allows bootstrap identity and membership reads before local restoration', async () => {
    const h = await setup();
    h.owners.beginAuthenticatedOwner();
    stop?.();
    stop = undefined;
    h.tokens.setActiveToken('bootstrap', Date.now() + 3_600_000);
    await expect(h.client.query('user.getMe')).resolves.toEqual({ source: 'Bearer bootstrap' });
    await expect(h.client.query('organizations.list')).resolves.toEqual({
      source: 'Bearer bootstrap',
    });
  });

  it.each([
    'activeSessions.createWebTicket',
    'user.registerPushToken',
    'user.unregisterPushToken',
    'user.revokeCurrentDeviceSession',
    'kiloPass.completeAppStorePurchase',
  ])('dispatches the exact passive %s contract while locked', async path => {
    const h = await setup(true);
    h.tokens.setActiveToken('token-A', Date.now() + 3_600_000);
    h.access.lockLocalAccess();
    const input = { token: 'push-token', signedTransactionJws: 'paid-jws' };
    await expect(h.client.mutation(path, input)).resolves.toEqual({ source: 'Bearer token-A' });
    expect(JSON.parse(firstRequest()[1]?.body as string)).toEqual(input);
    expect(urlString(firstRequest()[0])).not.toContain('batch=1');
  });

  it('rejects an unclassified mutation without dispatch while locked', async () => {
    const h = await setup(true);
    h.access.lockLocalAccess();
    await expect(h.client.mutation('future.effect', {})).rejects.toMatchObject(denied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks the original admission after latency and never replays after unlock', async () => {
    latency.session = 25;
    const h = await setup(true);
    h.tokens.setActiveToken('token-A', Date.now() + 3_600_000);
    vi.useFakeTimers();
    const pending = outcome(h.client.mutation('cliSessionsV2.get', {}));
    await vi.advanceTimersByTimeAsync(5);
    h.access.lockLocalAccess();
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject(denied);
    await h.access.requestLocalAccess('unlock');
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'fences parsed publication, including stale unauthorized=%s',
    async unauthorized => {
      const h = await setup();
      h.tokens.setActiveToken('token-A', Date.now() + 3_600_000);
      const parsing = Promise.withResolvers<undefined>();
      const began = Promise.withResolvers<undefined>();
      const response = Response.json(null);
      vi.spyOn(response, 'json').mockImplementation(async () => {
        began.resolve(undefined);
        await parsing.promise;
        return unauthorized
          ? [
              {
                error: {
                  message: 'old unauthorized',
                  code: -32_001,
                  data: { code: 'UNAUTHORIZED', authRequired: true },
                },
              },
            ]
          : [{ result: { data: 'old account data' } }];
      });
      fetchMock.mockResolvedValue(response);
      const pending = outcome(h.client.query('user.getMe'));
      await began.promise;
      h.replace();
      parsing.resolve(undefined);
      const error = await pending;
      expect(error).toMatchObject(denied);
      const handlers = await import('@/lib/auth/trpc-unauthorized');
      let signedInUser: string | null = 'B';
      const release = handlers.setTrpcUnauthorizedHandler(() => {
        signedInUser = null;
      });
      await handlers.handleTrpcQueryError(error);
      expect(signedInUser).toBe('B');
      release();
    }
  );

  it('preserves current-owner server error data and unauthorized handling', async () => {
    const h = await setup();
    fetchMock.mockResolvedValue(
      Response.json([
        {
          error: {
            message: 'not signed in',
            code: -32_001,
            data: { code: 'UNAUTHORIZED', authRequired: true },
          },
        },
      ])
    );
    const error = await outcome(h.client.query('user.getMe'));
    expect(error).toMatchObject({
      message: 'not signed in',
      data: { code: 'UNAUTHORIZED', authRequired: true },
    });
  });
});

describe('deadlineFetch', () => {
  it('returns a successful response without changing its body', async () => {
    const h = await setup();
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const response = await h.deadlineFetch('https://api.example.com/api/trpc');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
  it.each(['deadline', 'caller'] as const)(
    'preserves the %s abort while fetch is pending',
    async reason => {
      const h = await setup();
      vi.useFakeTimers();
      fetchMock.mockImplementation(async (_url, init) => {
        const response = await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error: unknown = init.signal?.reason;
            reject(error instanceof Error ? error : new Error('aborted'));
          });
        });
        return response;
      });
      const controller = new AbortController();
      const pending = outcome(
        h.deadlineFetch('https://api.example.com/api/trpc', { signal: controller.signal })
      );
      if (reason === 'deadline') {
        await vi.advanceTimersByTimeAsync(15_001);
      } else {
        controller.abort(new Error('caller cancelled mid-flight'));
      }
      expect(await pending).toMatchObject({
        message:
          reason === 'deadline' ? 'Request timed out after 15000ms' : 'caller cancelled mid-flight',
      });
    }
  );
  it('supports native signals without throwIfAborted', async () => {
    const h = await setup();
    const NativeAbortController = globalThis.AbortController;
    class LegacyAbortController extends NativeAbortController {
      constructor() {
        super();
        Object.defineProperty(this.signal, 'throwIfAborted', { value: undefined });
      }
    }
    vi.stubGlobal('AbortController', LegacyAbortController);
    fetchMock.mockResolvedValue(new Response('native response'));
    const response = await h.deadlineFetch('https://api.example.com/api/trpc');
    expect(await response.text()).toBe('native response');
  });
  it('rejects an already-aborted signal without dispatch', async () => {
    const h = await setup();
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(
      h.deadlineFetch('https://api.example.com/api/trpc', { signal: controller.signal })
    ).rejects.toThrow('caller cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
