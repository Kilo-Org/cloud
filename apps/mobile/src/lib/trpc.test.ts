/* oxlint-disable max-lines -- one tRPC client suite; the link-options, auth-header, deadline, and observed-fetch cases share one hoisted module-mock scaffold */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TelemetryEvent } from '@/lib/telemetry/error-sink';

const httpLinkMock = vi.hoisted(() => vi.fn());
const httpBatchLinkMock = vi.hoisted(() => vi.fn());
const createTRPCClientMock = vi.hoisted(() => vi.fn());
const splitLinkMock = vi.hoisted(() =>
  vi.fn((opts: { condition: unknown; true: unknown; false: unknown }) => [opts.true, opts.false])
);

// Mutable so a test can toggle the optional ingest endpoint before importing
// trpc.ts (`vi.resetModules()` re-reads the config mock factory).
const latencyIngestUrlMock = vi.hoisted(() => ({ value: undefined as string | undefined }));

const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'test-request-id'));

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
  // The secure-store read path reads this fault window; keep it closed.
  E2E_SECURE_STORE_FAULT_MS: 0,
  // A getter, not a snapshot: the mock factory object is cached, so a test
  // must be able to swap the optional endpoint without re-running it.
  get LATENCY_INGEST_URL(): string | undefined {
    return latencyIngestUrlMock.value;
  },
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
  splitLinkMock.mockClear();
  randomUUIDMock.mockClear();
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

type SplitCondition = (op: { path: string; context: { skipBatch?: boolean } }) => boolean;

type LatencySample = {
  requestId: string;
  procedures: string[];
  ttfbMs: number;
  totalMs: number;
  status: number;
  ok: boolean;
};

function latencySample(overrides: Partial<LatencySample> = {}): LatencySample {
  return {
    requestId: 'req-1',
    procedures: ['user.getMe'],
    ttfbMs: 5,
    totalMs: 9,
    status: 200,
    ok: true,
    ...overrides,
  };
}

describe('latency wiring', () => {
  beforeEach(() => {
    latencyIngestUrlMock.value = undefined;
    secureStoreMock.store.clear();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    // The platform `crypto` API the request-id generator reads; the stub makes
    // the id deterministic. The same shape exists on iOS and Android Hermes.
    vi.stubGlobal('crypto', { randomUUID: randomUUIDMock });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    latencyIngestUrlMock.value = undefined;
  });

  async function loadLatencyLinks(): Promise<{
    condition: SplitCondition;
    httpFetch: typeof fetch;
    batchFetch: typeof fetch;
  }> {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    await import('./trpc');

    const splitOpts = splitLinkMock.mock.calls.at(-1)?.[0] as
      | { condition: SplitCondition }
      | undefined;
    const httpOpts = httpLinkMock.mock.calls.at(-1)?.[0] as { fetch?: typeof fetch } | undefined;
    const batchOpts = httpBatchLinkMock.mock.calls.at(-1)?.[0] as
      | { fetch?: typeof fetch }
      | undefined;
    if (!splitOpts || !httpOpts?.fetch || !batchOpts?.fetch) {
      throw new Error('tRPC link options were not captured');
    }
    return {
      condition: splitOpts.condition,
      httpFetch: httpOpts.fetch,
      batchFetch: batchOpts.fetch,
    };
  }

  it('routes each unbatch candidate to the single link and the rest to the batch link', async () => {
    const { condition } = await loadLatencyLinks();

    for (const path of [
      'user.getMe',
      'activeSessions.list',
      'cliSessionsV2.getSessionMessagesPage',
    ]) {
      expect(condition({ path, context: {} })).toBe(true);
    }
    expect(condition({ path: 'kiloPass.getState', context: {} })).toBe(false);
    expect(condition({ path: 'some.unlisted.procedure', context: {} })).toBe(false);
  });

  it('keeps the explicit skipBatch override for every path', async () => {
    const { condition } = await loadLatencyLinks();

    expect(condition({ path: 'kiloPass.getState', context: { skipBatch: true } })).toBe(true);
    expect(condition({ path: 'user.getMe', context: { skipBatch: true } })).toBe(true);
  });

  it('gives the single and batch links the same latency-wrapped fetch', async () => {
    const { httpFetch, batchFetch } = await loadLatencyLinks();
    expect(httpFetch).toBe(batchFetch);

    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    await httpFetch('https://api.example.com/api/trpc/user.getMe', {
      headers: { authorization: 'Bearer token' },
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const sent = new Headers(init?.headers);
    expect(sent.get('x-kilo-request-id')).toBe('test-request-id');
    expect(sent.get('authorization')).toBe('Bearer token');
  });

  // The id comes from the platform `crypto` API every build carries; a
  // runtime that omits `randomUUID` still stamps a unique id, so neither
  // platform loses a sample (or needs a native module just for the id).
  it('stamps a unique request id when the platform crypto API has no randomUUID', async () => {
    vi.stubGlobal('crypto', {});
    const { httpFetch } = await loadLatencyLinks();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    await httpFetch('https://api.example.com/api/trpc/user.getMe', {});
    await httpFetch('https://api.example.com/api/trpc/user.getMe', {});

    const firstInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const secondInit = mockFetch.mock.calls[1]?.[1] as RequestInit | undefined;
    const first = new Headers(firstInit?.headers).get('x-kilo-request-id');
    const second = new Headers(secondInit?.headers).get('x-kilo-request-id');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  // tRPC's single `httpLink` leaves the body off a POST for a no-input call,
  // and the server's fetch adapter rejects that empty body with 400. The
  // shared fetch sends `{}` so an unbatched no-input query reaches its
  // procedure, matching the batched `{"0":{"json":null}}` shape.
  it('sends an empty JSON object body when a POST has none', async () => {
    const { httpFetch } = await loadLatencyLinks();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    await httpFetch('https://api.example.com/api/trpc/activeSessions.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBe('{}');
  });

  it('keeps a body the caller already provided', async () => {
    const { httpFetch } = await loadLatencyLinks();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    await httpFetch('https://api.example.com/api/trpc/activeSessions.list', {
      method: 'POST',
      body: '{"organizationId":null}',
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBe('{"organizationId":null}');
  });

  it('posts a non-empty batch with auth, client metadata, and the JSON content type', async () => {
    latencyIngestUrlMock.value = 'https://latency.example.com';
    secureStoreMock.store.set('auth-token', 'stored-token');
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { postLatencyBatch } = await import('@/lib/telemetry/latency-ingest');
    const samples = [latencySample()];

    await postLatencyBatch({ samples });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://latency.example.com/v1/latency');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ samples });
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer stored-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-kilo-client')).toBe('mobile');
    expect(headers.get('x-kilo-app-platform')).toBe('ios');
    expect(headers.get('x-kilo-app-version')).toBe('1.0.4');
  });

  it('does nothing when the ingest endpoint is unset', async () => {
    latencyIngestUrlMock.value = undefined;
    const { postLatencyBatch } = await import('@/lib/telemetry/latency-ingest');

    await postLatencyBatch({ samples: [latencySample()] });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing for an empty batch', async () => {
    latencyIngestUrlMock.value = 'https://latency.example.com';
    const { postLatencyBatch } = await import('@/lib/telemetry/latency-ingest');

    await postLatencyBatch({ samples: [] });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('drops the batch quietly on a network failure', async () => {
    latencyIngestUrlMock.value = 'https://latency.example.com';
    mockFetch.mockRejectedValue(new Error('ingest down'));
    const { postLatencyBatch } = await import('@/lib/telemetry/latency-ingest');

    await expect(postLatencyBatch({ samples: [latencySample()] })).resolves.toBeUndefined();
  });

  it('drops the batch quietly on a 5xx response', async () => {
    latencyIngestUrlMock.value = 'https://latency.example.com';
    mockFetch.mockResolvedValue(new Response('nope', { status: 503 }));
    const { postLatencyBatch } = await import('@/lib/telemetry/latency-ingest');

    await expect(postLatencyBatch({ samples: [latencySample()] })).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
