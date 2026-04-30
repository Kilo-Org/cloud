import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {},
  WorkerEntrypoint: class FakeWorkerEntrypoint {
    env: unknown;
    ctx: unknown;

    constructor(env: unknown, ctx: unknown) {
      this.env = env;
      this.ctx = ctx;
    }
  },
}));

vi.mock('./routes', async () => {
  const { Hono } = await import('hono');
  const empty = new Hono();
  const controller = new Hono();
  controller.post('/google/token', c => c.json({ ok: true }, 200));
  return {
    accessGatewayRoutes: empty,
    publicRoutes: empty,
    api: empty,
    kiloclaw: empty,
    platform: empty,
    controller,
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

import WorkerEntrypoint, { app } from './index';
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

  it('rejects platform routes when KILOCLAW_INTERNAL_API_SECRET is missing', async () => {
    const response = await app.fetch(
      new Request('https://example.com/api/platform/provision', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'secret-123',
        },
        body: JSON.stringify({ userId: 'user-1' }),
      }),
      {
        INTERNAL_API_SECRET: 'next-internal-api-secret',
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        NEXTAUTH_SECRET: 'nextauth-secret',
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
      'KILOCLAW_INTERNAL_API_SECRET'
    );
  });

  it('rejects platform routes when NEXTAUTH_SECRET is missing', async () => {
    const response = await app.fetch(
      new Request('https://example.com/api/platform/provision', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'secret-123',
        },
        body: JSON.stringify({ userId: 'user-1' }),
      }),
      {
        INTERNAL_API_SECRET: 'next-internal-api-secret',
        KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
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

describe('controller google env validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('rejects controller google routes when broker env is missing', async () => {
    const response = await app.fetch(
      new Request('https://example.com/api/controller/google/token', {
        method: 'POST',
      }),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({ error: 'Configuration error' });
    expect(console.error).toHaveBeenCalledWith(
      '[CONFIG] Controller Google route missing bindings:',
      'GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY, GOOGLE_WORKSPACE_OAUTH_CLIENT_ID, GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET'
    );
  });

  it('allows controller google routes when broker env is configured', async () => {
    const response = await app.fetch(
      new Request('https://example.com/api/controller/google/token', {
        method: 'POST',
      }),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: 'client-secret',
        GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY: 'refresh-key',
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
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

    const response = await app.fetch(
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

describe('kilo-chat webhook delivery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes service-binding webhook payloads to the target instance gateway', async () => {
    const sandboxId = 'ki_550e8400e29b41d4a716446655440000';
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({ sandboxId }),
      getRoutingTarget: vi.fn().mockResolvedValue({
        origin: 'https://test-app.fly.dev',
        headers: { 'fly-force-instance-id': 'machine-1' },
      }),
    };
    const instanceNamespace = {
      idFromName: vi.fn().mockReturnValue('instance-id'),
      get: vi.fn().mockReturnValue(instanceStub),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const worker = new WorkerEntrypoint(
      {
        KILOCLAW_INSTANCE: instanceNamespace,
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
      } as never,
      {} as never
    );

    await worker.deliverChatWebhook({
      type: 'message.created',
      targetBotId: `bot:kiloclaw:${sandboxId}`,
      conversationId: '01KP8R0VX4HK4ZSVQR5ZBVKHQH',
      messageId: '01KP8R0VX4HK4ZSVQR5ZBVKHQJ',
      from: 'user-1',
      text: 'Hello',
      sentAt: '2026-04-21T12:00:00.000Z',
    });

    expect(instanceNamespace.idFromName).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000'
    );
    expect(instanceNamespace.get).toHaveBeenCalledWith('instance-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { input, init } = getFetchCall(fetchMock);
    expect(input).toBe('https://test-app.fly.dev/plugins/kilo-chat/webhook');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({
        type: 'message.created',
        conversationId: '01KP8R0VX4HK4ZSVQR5ZBVKHQH',
        messageId: '01KP8R0VX4HK4ZSVQR5ZBVKHQJ',
        from: 'user-1',
        text: 'Hello',
        sentAt: '2026-04-21T12:00:00.000Z',
      })
    );
    if (!(init?.headers instanceof Headers)) {
      throw new Error('Expected webhook fetch headers to be a Headers instance');
    }
    expect(init.headers.get('x-kiloclaw-proxy-token')).toBe(
      await deriveGatewayToken(sandboxId, 'gateway-secret')
    );
    expect(init.headers.get('fly-force-instance-id')).toBe('machine-1');
    expect(init.headers.get('content-type')).toBe('application/json');
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

    const response = await app.fetch(
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

    const response = await app.fetch(
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

    const response = await app.fetch(
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

  it('does not start or retry the default HTTP proxy when the upstream fetch fails', async () => {
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
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
      }),
      start: vi.fn().mockResolvedValue({ started: true }),
      getRoutingTarget: vi.fn().mockResolvedValue({
        origin: 'https://test-app.fly.dev',
        headers: {
          'fly-force-instance-id': 'machine-1',
        },
      }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));

    const response = await app.fetch(
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
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not reachable',
      hint: 'Your instance may not be running. Start it from the dashboard.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(instanceStub.start).not.toHaveBeenCalled();
  });

  it('does not start or retry the default WebSocket proxy when the upstream fetch fails', async () => {
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
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
      }),
      start: vi.fn().mockResolvedValue({ started: true }),
      getRoutingTarget: vi.fn().mockResolvedValue({
        origin: 'https://test-app.fly.dev',
        headers: {
          'fly-force-instance-id': 'machine-1',
        },
      }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));

    const response = await app.fetch(
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
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not reachable',
      hint: 'Your instance may not be running. Start it from the dashboard.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(instanceStub.start).not.toHaveBeenCalled();
  });
});
