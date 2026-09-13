/* oxlint-disable max-lines -- one tRPC client suite; the link-options, auth-header, deadline, and observed-fetch cases share one hoisted module-mock scaffold */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TelemetryEvent } from '@/lib/telemetry/error-sink';

const httpLinkMock = vi.hoisted(() => vi.fn());
const httpBatchLinkMock = vi.hoisted(() => vi.fn());
const createTRPCClientMock = vi.hoisted(() => vi.fn());
const splitLinkMock = vi.hoisted(() =>
  vi.fn((opts: { condition: unknown; true: unknown; false: unknown }) => [opts.true, opts.false])
);

const secureStoreMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  let heldExpiryRead: Promise<void> | null = null;
  let releaseExpiryRead: (() => void) | null = null;
  return {
    store,
    // Holds the TOKEN_EXPIRES_AT_KEY read open so a test can publish a newer
    // owner while the cold expiry read is in flight.
    holdExpiryRead(): void {
      heldExpiryRead = new Promise<void>(resolve => {
        releaseExpiryRead = resolve;
      });
    },
    releaseHeldExpiryRead(): void {
      releaseExpiryRead?.();
      heldExpiryRead = null;
      releaseExpiryRead = null;
    },
    getItemAsync: vi.fn(async (key: string) => {
      if (key === 'token-expires-at' && heldExpiryRead) {
        await heldExpiryRead;
      }
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
  };
});

vi.mock('@trpc/client', () => ({
  createTRPCClient: createTRPCClientMock,
  httpLink: httpLinkMock,
  httpBatchLink: httpBatchLinkMock,
  splitLink: splitLinkMock,
}));

vi.mock('@trpc/tanstack-react-query', () => ({
  createTRPCContext: vi.fn(() => ({
    TRPCProvider: { $$typeof: Symbol.for('react.provider') },
    useTRPC: vi.fn(),
  })),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMock.getItemAsync,
  setItemAsync: secureStoreMock.setItemAsync,
  deleteItemAsync: secureStoreMock.deleteItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  E2E_LATENCY_MESSAGES_MS: 0,
  E2E_LATENCY_SESSION_MS: 0,
}));

vi.mock('@/lib/storage-keys', () => ({
  AUTH_TOKEN_KEY: 'auth-token',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
}));

// auth-context pulls in react-native, Sentry and the telemetry modules.
// This test only inspects link options, so stub the two symbols trpc.ts uses.
vi.mock('@/lib/auth/auth-context', () => ({
  performRefresh: vi.fn().mockResolvedValue({ ok: false, refused: false }),
  REFRESH_MARGIN_MS: 60_000,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

afterEach(() => {
  vi.resetModules();
  httpLinkMock.mockClear();
  httpBatchLinkMock.mockClear();
  createTRPCClientMock.mockClear();
});

describe('tRPC client link options', () => {
  it('passes methodOverride: "POST" to httpLink', async () => {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    await import('./trpc');

    expect(httpLinkMock).toHaveBeenCalledTimes(1);
    const httpLinkOpts = httpLinkMock.mock.calls[0]?.[0];
    expect(httpLinkOpts).toHaveProperty('methodOverride', 'POST');
  });

  it('passes methodOverride: "POST" to httpBatchLink', async () => {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    await import('./trpc');

    expect(httpBatchLinkMock).toHaveBeenCalledTimes(1);
    const httpBatchLinkOpts = httpBatchLinkMock.mock.calls[0]?.[0];
    expect(httpBatchLinkOpts).toHaveProperty('methodOverride', 'POST');
  });
});

type AuthHeadersFn = () => Promise<Record<string, string>>;

describe('getAuthHeaders', () => {
  beforeEach(() => {
    secureStoreMock.store.clear();
    secureStoreMock.getItemAsync.mockClear();
    httpLinkMock.mockClear();
    httpBatchLinkMock.mockClear();
    createTRPCClientMock.mockClear();
  });

  afterEach(() => {
    secureStoreMock.getItemAsync.mockRestore();
    secureStoreMock.releaseHeldExpiryRead();
  });

  async function loadHeaders(): Promise<AuthHeadersFn> {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    await import('./trpc');

    const httpLinkOpts = httpLinkMock.mock.calls[0]?.[0] as { headers?: AuthHeadersFn } | undefined;
    if (!httpLinkOpts?.headers) {
      throw new Error('headers option was not captured from httpLink');
    }
    return httpLinkOpts.headers;
  }

  it('reads TOKEN_EXPIRES_AT_KEY once on the cold path and reuses the owner expiry', async () => {
    secureStoreMock.store.set('auth-token', 'stored-token');
    secureStoreMock.store.set('token-expires-at', String(Date.now() + 3_600_000));
    const headers = await loadHeaders();

    await expect(headers()).resolves.toMatchObject({ Authorization: 'Bearer stored-token' });
    // Cold path: one token read plus one expiry read.
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(2);

    // The resolved expiry was published into the owner: a normal request
    // rereads neither key.
    await expect(headers()).resolves.toMatchObject({ Authorization: 'Bearer stored-token' });
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it('uses the newest owner token published while the cold expiry was read', async () => {
    secureStoreMock.store.set('auth-token', 'stored-token');
    secureStoreMock.store.set('token-expires-at', String(Date.now() - 1000));
    const headers = await loadHeaders();

    // The token read completes first and warms the owner with a null expiry;
    // the held TOKEN_EXPIRES_AT_KEY read is where the race lands.
    secureStoreMock.holdExpiryRead();
    const pending = headers();
    await vi.waitFor(() => {
      expect(vi.mocked(secureStoreMock.getItemAsync)).toHaveBeenCalledWith('token-expires-at');
    });
    // Publish a newer owner while the cold expiry read is still in flight.
    const { setActiveToken } = await import('@/lib/auth/token-owner');
    setActiveToken('newer-token', Date.now() + 3_600_000);
    secureStoreMock.releaseHeldExpiryRead();

    // The request uses the newest owner token, not the cold-read token, and
    // the newer owner's expiry is not overwritten by the stale read.
    await expect(pending).resolves.toMatchObject({ Authorization: 'Bearer newer-token' });
  });
});

const mockFetch = vi.fn();

// Suppress Node.js 24 unhandledRejection from AbortController.abort()
// with a non-DOMException reason during fake-timer tests.
// eslint-disable-next-line @typescript-eslint/no-empty-function
function swallowUnhandledRejection(): void {}

describe('deadlineFetch', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns the response when fetch completes before the deadline', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    const { deadlineFetch } = await import('./trpc');
    const response = await deadlineFetch('https://api.example.com/api/trpc');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects with RequestDeadlineError when the deadline expires', async () => {
    vi.useFakeTimers();
    process.on('unhandledRejection', swallowUnhandledRejection);
    try {
      // Fetch never resolves unless its signal aborts — simulates a hanging
      // backend where the only thing that cancels the request is the deadline.
      mockFetch.mockImplementation(
        // eslint-disable-next-line typescript-eslint/promise-function-async
        (_url, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason as Error);
              return;
            }
            const id = setTimeout(resolve, 60_000, new Response('never'));
            signal?.addEventListener('abort', () => {
              clearTimeout(id);
              reject(signal.reason as Error);
            });
          })
      );
      const { deadlineFetch } = await import('./trpc');
      const promise = deadlineFetch('https://api.example.com/api/trpc');

      vi.advanceTimersByTime(15_001);
      // eslint-disable-next-line typescript-eslint/await-thenable
      await vi.runAllTicks();

      await expect(promise).rejects.toThrow('timed out after 15000ms');
    } finally {
      process.off('unhandledRejection', swallowUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const { deadlineFetch } = await import('./trpc');
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    const promise = deadlineFetch('https://api.example.com/api/trpc', {
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow('caller cancelled');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects with the caller abort reason when the signal is aborted during fetch', async () => {
    vi.useFakeTimers();
    try {
      // Fetch hangs unless its signal aborts.
      mockFetch.mockImplementation(
        // eslint-disable-next-line typescript-eslint/promise-function-async
        (_url, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason as Error);
              return;
            }
            signal?.addEventListener('abort', () => {
              reject(signal.reason as Error);
            });
          })
      );

      const { deadlineFetch } = await import('./trpc');
      const controller = new AbortController();
      const promise = deadlineFetch('https://api.example.com/api/trpc', {
        signal: controller.signal,
      });

      // Let the fetch start, then abort from the caller side.
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error('caller cancelled mid-flight'));

      // eslint-disable-next-line typescript-eslint/await-thenable
      await vi.runAllTicks();

      await expect(promise).rejects.toThrow('caller cancelled mid-flight');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('network error reporting', () => {
  let events: TelemetryEvent[] = [];

  beforeEach(() => {
    events = [];
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // `vi.resetModules()` (outer afterEach) drops the module registry, so the
  // error-sink used by the freshly imported trpc.ts must be the same instance
  // the fake sink is installed on. Import the sink from that registry first.
  async function loadObservedFetch(): Promise<typeof fetch> {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    const { setTelemetrySink } = await import('@/lib/telemetry/error-sink');
    await import('./trpc');
    setTelemetrySink(event => {
      events.push(event);
    });

    const httpLinkOpts = httpLinkMock.mock.calls[0]?.[0] as { fetch?: typeof fetch } | undefined;
    if (!httpLinkOpts?.fetch) {
      throw new Error('fetch option was not captured from httpLink');
    }
    return httpLinkOpts.fetch;
  }

  it('reports one warning tagged error.source trpc carrying the procedure on rejection', async () => {
    const original = new Error('socket closed');
    mockFetch.mockRejectedValue(original);
    const observedFetch = await loadObservedFetch();

    await expect(
      observedFetch('https://api.example.com/api/trpc/session.list?batch=1')
    ).rejects.toBe(original);

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.tags).toMatchObject({
      'error.subsystem': 'network',
      'error.source': 'trpc',
      'network.outcome': 'failed',
      'trpc.procedure': 'session.list',
    });
    expect(events[0]?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'failed']);
  });

  it('reports a non-2xx response', async () => {
    mockFetch.mockResolvedValue(
      new Response('nope', { status: 503, statusText: 'Service Unavailable' })
    );
    const observedFetch = await loadObservedFetch();

    const response = await observedFetch('https://api.example.com/api/trpc/session.list');

    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      'error.source': 'trpc',
      'http.status': 503,
      'http.status_class': '5xx',
      'network.outcome': 'http_error',
    });
  });

  it('reports a 207 batched response once and still returns it', async () => {
    const body = [
      { result: { data: 'ok' } },
      {
        error: {
          message: 'forbidden',
          code: -32_003,
          data: { code: 'FORBIDDEN', httpStatus: 403, path: 'session.list' },
        },
      },
    ];
    mockFetch.mockResolvedValue(Response.json(body, { status: 207 }));
    const observedFetch = await loadObservedFetch();

    const response = await observedFetch('https://api.example.com/api/trpc/session.list?batch=1');

    expect(response.status).toBe(207);
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.tags).toMatchObject({
      'error.subsystem': 'network',
      'error.source': 'trpc',
      'http.status': 207,
      'network.outcome': 'http_error',
      'trpc.procedure': 'session.list',
      'trpc.code': 'FORBIDDEN',
    });
  });
});
