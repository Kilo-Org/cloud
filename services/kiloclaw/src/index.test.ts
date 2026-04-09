import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {},
}));

vi.mock('./routes', async () => {
  const { Hono } = await import('hono');
  const empty = new Hono();
  return {
    accessGatewayRoutes: empty,
    publicRoutes: empty,
    api: empty,
    kiloclaw: empty,
    platform: empty,
    controller: empty,
  };
});

vi.mock('./auth', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', 'user-1');
    await next();
  },
  internalApiMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./middleware/analytics', () => ({
  timingMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./lib/image-version', async () => {
  const actual = await vi.importActual('./lib/image-version');
  return {
    ...actual,
    registerVersionIfNeeded: vi.fn().mockResolvedValue(undefined),
  };
});

import worker from './index';
import { deriveGatewayToken } from './auth/gateway-token';
import { KILOCLAW_ACTIVE_INSTANCE_COOKIE } from './config';

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
>;

function getFetchCall(
  fetchMock: FetchMock,
  index = 0
): { input: unknown; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call at index ${index}`);
  }

  const input = call[0];
  const rawInit = call[1];
  const init = rawInit && typeof rawInit === 'object' ? rawInit : undefined;
  return { input, init };
}

describe('platform route env validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rejects platform routes when NEXTAUTH_SECRET is missing', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/platform/provision', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'secret-123',
        },
        body: JSON.stringify({ userId: 'user-1' }),
      }),
      {
        INTERNAL_API_SECRET: 'secret-123',
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({ error: 'Configuration error' });
    expect(console.error).toHaveBeenCalledWith(
      '[CONFIG] Platform route missing bindings:',
      'NEXTAUTH_SECRET'
    );
  });
});

describe('proxy recovering state', () => {
  it('returns 409 while the instance is recovering', async () => {
    const registryStub = {
      listInstances: vi.fn().mockResolvedValue([
        {
          doKey: 'user-1',
          instanceId: '',
          assignedUserId: 'user-1',
          createdAt: new Date().toISOString(),
          destroyedAt: null,
        },
      ]),
    };
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'sandbox-1',
        status: 'recovering',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
      }),
    };

    const response = await worker.fetch(
      new Request('https://example.com/'),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
        FLY_APP_NAME: 'test-app',
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Instance is recovering',
      hint: 'Your instance is being recovered after an unexpected stop. Please wait.',
    });
  });
});

describe('proxy routing target usage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies through the provider routing target headers for /i routes', async () => {
    const registryStub = {
      listInstances: vi.fn(),
    };
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'sandbox-1',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
      }),
      getRoutingTarget: vi.fn().mockResolvedValue({
        origin: 'https://test-app.fly.dev',
        headers: {
          'fly-force-instance-id': 'machine-1',
          'x-provider-route': 'provider-hop',
        },
      }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock.mockResolvedValue(
      new Response('ok', {
        status: 200,
      })
    );

    const response = await worker.fetch(
      new Request('https://example.com/i/550e8400-e29b-41d4-a716-446655440000/api/foo?bar=baz'),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
        FLY_APP_NAME: 'test-app',
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);
    const { input, init } = getFetchCall(fetchMock);
    expect(input).toBe('https://test-app.fly.dev/api/foo?bar=baz');
    expect(init).toBeDefined();
    expect(init?.method).toBe('GET');
    expect(init?.headers).toBeInstanceOf(Headers);

    const headers = init?.headers;
    if (!(headers instanceof Headers)) {
      throw new Error('Expected fetch headers to be a Headers instance');
    }
    expect(headers.get('fly-force-instance-id')).toBe('machine-1');
    expect(headers.get('x-provider-route')).toBe('provider-hop');
    expect(headers.get('x-kiloclaw-proxy-token')).toBeTruthy();
  });

  it('returns 503 for an owned cookie-routed instance when the routing target is unavailable', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'sandbox-1',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
      }),
      getRoutingTarget: vi.fn().mockResolvedValue(null),
    };

    const response = await worker.fetch(
      new Request('https://example.com/', {
        headers: {
          Cookie: `${KILOCLAW_ACTIVE_INSTANCE_COOKIE}=550e8400-e29b-41d4-a716-446655440000`,
        },
      }),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
        FLY_APP_NAME: 'test-app',
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not routable',
    });
  });

  it('proxies to docker-local runtimes using the generic runtime id', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'sandbox-1',
        status: 'running',
        provider: 'docker-local',
        runtimeId: 'kiloclaw-sandbox-1',
        flyMachineId: null,
        flyAppName: null,
      }),
      getRoutingTarget: vi.fn().mockResolvedValue({
        origin: 'http://127.0.0.1:45001',
        headers: {},
      }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const response = await worker.fetch(
      new Request('https://example.com/i/550e8400-e29b-41d4-a716-446655440000/api/foo'),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);
    const { input } = getFetchCall(fetchMock);
    expect(input).toBe('http://127.0.0.1:45001/api/foo');
  });

  it('rebuilds HTTP retry auth with the refreshed authoritative sandbox id after crash recovery', async () => {
    const registryStub = {
      listInstances: vi.fn().mockResolvedValue([
        {
          doKey: 'user-1',
          instanceId: '',
          assignedUserId: 'user-1',
          createdAt: new Date().toISOString(),
          destroyedAt: null,
        },
      ]),
    };
    const instanceStub = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-old',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-old',
          flyMachineId: 'machine-old',
          flyAppName: 'test-app',
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-old',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-old',
          flyMachineId: 'machine-old',
          flyAppName: 'test-app',
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-new',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-new',
          flyMachineId: 'machine-new',
          flyAppName: 'test-app',
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-new',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-new',
          flyMachineId: 'machine-new',
          flyAppName: 'test-app',
        }),
      start: vi.fn().mockResolvedValue({ started: true }),
      getRoutingTarget: vi
        .fn()
        .mockResolvedValueOnce({
          origin: 'https://test-app.fly.dev',
          headers: {
            'fly-force-instance-id': 'machine-old',
          },
        })
        .mockResolvedValueOnce({
          origin: 'https://test-app.fly.dev',
          headers: {
            'fly-force-instance-id': 'machine-new',
          },
        }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await worker.fetch(
      new Request('https://example.com/api/foo?bar=baz'),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
        FLY_APP_NAME: 'test-app',
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
        KILOCLAW_AE: { writeDataPoint: vi.fn() },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);

    const retryCall = getFetchCall(fetchMock, 1);
    if (!(retryCall.init?.headers instanceof Headers)) {
      throw new Error('Expected retry fetch headers to be a Headers instance');
    }

    expect(retryCall.init.headers.get('fly-force-instance-id')).toBe('machine-new');
    expect(retryCall.init.headers.get('x-kiloclaw-proxy-token')).toBe(
      await deriveGatewayToken('sandbox-new', 'gateway-secret')
    );
  });

  it('rebuilds WebSocket retry auth with the refreshed authoritative sandbox id after crash recovery', async () => {
    const registryStub = {
      listInstances: vi.fn().mockResolvedValue([
        {
          doKey: 'user-1',
          instanceId: '',
          assignedUserId: 'user-1',
          createdAt: new Date().toISOString(),
          destroyedAt: null,
        },
      ]),
    };
    const instanceStub = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-old',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-old',
          flyMachineId: 'machine-old',
          flyAppName: 'test-app',
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-old',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-old',
          flyMachineId: 'machine-old',
          flyAppName: 'test-app',
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-new',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-new',
          flyMachineId: 'machine-new',
          flyAppName: 'test-app',
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          sandboxId: 'sandbox-new',
          status: 'running',
          provider: 'fly',
          runtimeId: 'machine-new',
          flyMachineId: 'machine-new',
          flyAppName: 'test-app',
        }),
      start: vi.fn().mockResolvedValue({ started: true }),
      getRoutingTarget: vi
        .fn()
        .mockResolvedValueOnce({
          origin: 'https://test-app.fly.dev',
          headers: {
            'fly-force-instance-id': 'machine-old',
          },
        })
        .mockResolvedValueOnce({
          origin: 'https://test-app.fly.dev',
          headers: {
            'fly-force-instance-id': 'machine-new',
          },
        }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await worker.fetch(
      new Request('https://example.com/socket', {
        headers: { Upgrade: 'websocket' },
      }),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
        FLY_APP_NAME: 'test-app',
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
        KILOCLAW_AE: { writeDataPoint: vi.fn() },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);

    const retryCall = getFetchCall(fetchMock, 1);
    if (!(retryCall.init?.headers instanceof Headers)) {
      throw new Error('Expected retry fetch headers to be a Headers instance');
    }

    expect(retryCall.init.headers.get('fly-force-instance-id')).toBe('machine-new');
    expect(retryCall.init.headers.get('x-kiloclaw-proxy-token')).toBe(
      await deriveGatewayToken('sandbox-new', 'gateway-secret')
    );
  });
});
