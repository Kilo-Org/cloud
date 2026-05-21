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

  it('rejects platform routes when INTERNAL_API_SECRET is missing', async () => {
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
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
        FLY_API_TOKEN: 'fly-token',
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({ error: 'Configuration error' });
    expect(console.error).toHaveBeenCalledWith(
      '[CONFIG] Platform route missing bindings:',
      'INTERNAL_API_SECRET'
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
        INTERNAL_API_SECRET: 'claw-secret',
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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

// Regression: a stopped Fly machine still has flyMachineId/runtimeId set, and
// proxying to it would trigger Fly Proxy's autostart — silently waking
// instances we deliberately suspended (subscription_expiry, manual stop, etc.)
// and feeding the once-per-hour suspension-email loop. Each branch must refuse
// to forward unless the DO status is strictly 'running'.
describe('proxy refuses to wake stopped instances', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseEnv = () => ({
    NEXTAUTH_SECRET: 'nextauth-secret',
    GATEWAY_TOKEN_SECRET: 'gateway-secret',
    KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
    KILOCLAW_INSTANCE_URL_SCHEME: 'https',
    FLY_API_TOKEN: 'fly-token',
    FLY_APP_NAME: 'test-app',
  });

  const stoppedStatus = {
    userId: 'user-1',
    sandboxId: 'ki_550e8400e29b41d4a716446655440000',
    status: 'stopped' as const,
    provider: 'fly' as const,
    // runtimeId is still set: a stopped Fly machine retains its machine ID;
    // only the Fly state transitions to "stopped".
    runtimeId: 'machine-1',
    flyMachineId: 'machine-1',
    flyAppName: 'test-app',
    controllerCapabilitiesVersion: 2,
  };

  it('returns 409 for the /i/:instanceId branch and never proxies', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue(stoppedStatus),
      getRoutingTarget: vi.fn(),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;

    const response = await app.fetch(
      new Request('https://example.com/i/550e8400-e29b-41d4-a716-446655440000/api/foo'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not running',
      hint: 'Start it from the dashboard.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(instanceStub.getRoutingTarget).not.toHaveBeenCalled();
  });

  it('returns 409 for the host-based branch and never proxies', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue(stoppedStatus),
      getRoutingTarget: vi.fn(),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;

    const response = await app.fetch(
      new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/api/foo'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not running',
      hint: 'Start it from the dashboard.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(instanceStub.getRoutingTarget).not.toHaveBeenCalled();
  });

  it('returns 409 for the cookie-routed branch and never proxies', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue(stoppedStatus),
      getRoutingTarget: vi.fn(),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;

    const response = await app.fetch(
      new Request('https://example.com/', {
        headers: {
          Cookie: `${KILOCLAW_ACTIVE_INSTANCE_COOKIE}=550e8400-e29b-41d4-a716-446655440000`,
        },
      }),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not running',
      hint: 'Start it from the dashboard.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(instanceStub.getRoutingTarget).not.toHaveBeenCalled();
  });

  it('returns 409 for the default catch-all branch and never proxies', async () => {
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
      getStatus: vi.fn().mockResolvedValue(stoppedStatus),
      getRoutingTarget: vi.fn(),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;

    const response = await app.fetch(
      new Request('https://example.com/'),
      {
        ...baseEnv(),
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
      error: 'Instance not running',
      hint: 'Start it from the dashboard.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(instanceStub.getRoutingTarget).not.toHaveBeenCalled();
  });
});

// `starting` and `restarting` are platform-driven transient states. The
// previous proxyThroughTarget 502 → 503 retry path was strictly better UX
// than a flat 409 "Instance not running, start from dashboard" — the user
// already initiated start, the platform is actively working on it, and the
// right thing to tell the client is "retry shortly". The `stopped` gate
// above remains 409 because there it really IS the user's job to start.
describe('proxy returns 503 retry for transient starting states', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseEnv = () => ({
    NEXTAUTH_SECRET: 'nextauth-secret',
    GATEWAY_TOKEN_SECRET: 'gateway-secret',
    KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
    KILOCLAW_INSTANCE_URL_SCHEME: 'https',
    FLY_API_TOKEN: 'fly-token',
    FLY_APP_NAME: 'test-app',
  });

  const transientStatusBase = {
    userId: 'user-1',
    sandboxId: 'ki_550e8400e29b41d4a716446655440000',
    provider: 'fly' as const,
    runtimeId: 'machine-1',
    flyMachineId: 'machine-1',
    flyAppName: 'test-app',
    controllerCapabilitiesVersion: 2,
  };

  for (const transientStatus of ['starting', 'restarting'] as const) {
    it(`returns 503 with Retry-After for the /i/:instanceId branch when status='${transientStatus}'`, async () => {
      const instanceStub = {
        getStatus: vi.fn().mockResolvedValue({
          ...transientStatusBase,
          status: transientStatus,
        }),
        getRoutingTarget: vi.fn(),
      };
      const fetchMock = vi.mocked(fetch) as FetchMock;

      const response = await app.fetch(
        new Request('https://example.com/i/550e8400-e29b-41d4-a716-446655440000/api/foo'),
        {
          ...baseEnv(),
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
        error: 'Instance is starting up',
        hint: 'The instance is starting. Please retry shortly.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(instanceStub.getRoutingTarget).not.toHaveBeenCalled();
    });

    it(`returns 503 with Retry-After for the host-based branch when status='${transientStatus}'`, async () => {
      const instanceStub = {
        getStatus: vi.fn().mockResolvedValue({
          ...transientStatusBase,
          status: transientStatus,
        }),
        getRoutingTarget: vi.fn(),
      };
      const fetchMock = vi.mocked(fetch) as FetchMock;

      const response = await app.fetch(
        new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/api/foo'),
        {
          ...baseEnv(),
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
        error: 'Instance is starting up',
        hint: 'The instance is starting. Please retry shortly.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`returns 503 with Retry-After for the default catch-all branch when status='${transientStatus}'`, async () => {
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
          ...transientStatusBase,
          status: transientStatus,
        }),
        getRoutingTarget: vi.fn(),
      };
      const fetchMock = vi.mocked(fetch) as FetchMock;

      const response = await app.fetch(
        new Request('https://example.com/'),
        {
          ...baseEnv(),
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
        error: 'Instance is starting up',
        hint: 'Your instance is starting. Please retry shortly.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
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
      getStatus: vi.fn().mockResolvedValue({ sandboxId, status: 'running' }),
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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

  it('rejects targetBotId suffixes that are not valid sandboxIds before routing', async () => {
    for (const targetBotId of ['bot:kiloclaw:', 'bot:kiloclaw:bad$sandbox']) {
      const registryStub = { listInstances: vi.fn().mockResolvedValue([]) };
      const registryNamespace = {
        idFromName: vi.fn().mockReturnValue('registry-id'),
        get: vi.fn().mockReturnValue(registryStub),
      };
      const instanceNamespace = {
        idFromName: vi.fn().mockReturnValue('instance-id'),
        get: vi.fn(),
      };

      const worker = new WorkerEntrypoint(
        {
          KILOCLAW_INSTANCE: instanceNamespace,
          KILOCLAW_REGISTRY: registryNamespace,
          GATEWAY_TOKEN_SECRET: 'gateway-secret',
        } as never,
        {} as never
      );

      await expect(
        worker.deliverChatWebhook({
          type: 'bot.status_request',
          targetBotId,
        })
      ).rejects.toThrow(/Invalid sandboxId derived from targetBotId/);

      expect(registryNamespace.idFromName).not.toHaveBeenCalled();
      expect(instanceNamespace.idFromName).not.toHaveBeenCalled();
    }
  });

  // Regression: chat dispatchers (Slack/Discord/Telegram) call this RPC for
  // every inbound message. When the target instance is suspended for billing
  // or manually stopped, we must NOT issue fetch() against the Fly app —
  // doing so triggers Fly Proxy's autostart and silently wakes the machine,
  // creating churn and (before the TOCTOU defense in instance-lifecycle.ts)
  // feeding the duplicate-suspension-email loop.
  it('refuses to deliver chat webhooks to a non-running instance', async () => {
    const sandboxId = 'ki_550e8400e29b41d4a716446655440000';
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({ sandboxId, status: 'stopped' }),
      getRoutingTarget: vi.fn(),
    };
    const instanceNamespace = {
      idFromName: vi.fn().mockReturnValue('instance-id'),
      get: vi.fn().mockReturnValue(instanceStub),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;

    const worker = new WorkerEntrypoint(
      {
        KILOCLAW_INSTANCE: instanceNamespace,
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
      } as never,
      {} as never
    );

    await expect(
      worker.deliverChatWebhook({
        type: 'message.created',
        targetBotId: `bot:kiloclaw:${sandboxId}`,
        conversationId: '01KP8R0VX4HK4ZSVQR5ZBVKHQH',
        messageId: '01KP8R0VX4HK4ZSVQR5ZBVKHQJ',
        from: 'user-1',
        text: 'Hello',
        sentAt: '2026-04-21T12:00:00.000Z',
      })
    ).rejects.toThrow(/is not running \(status=stopped\)/);

    // Critically: the routing target was never resolved and no fetch was
    // issued, so Fly Proxy autostart cannot be triggered.
    expect(instanceStub.getRoutingTarget).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
        KILOCLAW_INSTANCE_URL_SCHEME: 'https',
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

describe('host-based routing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseEnv = () => ({
    NEXTAUTH_SECRET: 'nextauth-secret',
    GATEWAY_TOKEN_SECRET: 'gateway-secret',
    KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
    KILOCLAW_INSTANCE_URL_SCHEME: 'https',
    FLY_API_TOKEN: 'fly-token',
    FLY_APP_NAME: 'test-app',
  });

  it('routes an instance-keyed host to the owning DO and proxies through', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'ki_550e8400e29b41d4a716446655440000',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
        controllerCapabilitiesVersion: 2,
      }),
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
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const response = await app.fetch(
      new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/api/foo?bar=baz'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: instanceNamespace,
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);
    // DO is keyed by the instanceId (UUID), not by userId.
    expect(instanceNamespace.idFromName).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000'
    );
    const { input } = getFetchCall(fetchMock);
    expect(input).toBe('https://test-app.fly.dev/api/foo?bar=baz');
  });

  it('routes a legacy userId-keyed host to the owning DO', async () => {
    const legacyUserId = 'user-1';
    const legacySandboxId =
      // sandboxIdFromUserId('user-1') === base64url('user-1')
      // label is u-<base32hex('user-1')> — we let the code derive it.
      'dXNlci0x';
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: legacyUserId,
        sandboxId: legacySandboxId,
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
        controllerCapabilitiesVersion: 2,
      }),
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
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    // Label for userId 'user-1': u-{base32hex('user-1')} = u-ekgq6t9k65gq (derived)
    // Use the hostname-label helper to stay in sync if the encoding changes.
    const { hostnameLabelFromSandboxId } = await import('./auth/hostname-label');
    const label = hostnameLabelFromSandboxId(legacySandboxId);
    if (!label) throw new Error('Expected a label for legacy sandboxId');

    const response = await app.fetch(
      new Request(`https://${label}.kiloclaw.ai/ping`),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: instanceNamespace,
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);
    // DO is keyed by the decoded userId.
    expect(instanceNamespace.idFromName).toHaveBeenCalledWith(legacyUserId);
  });

  it('returns 403 when the host resolves to an instance owned by another user', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'other-user',
        sandboxId: 'ki_550e8400e29b41d4a716446655440000',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
        controllerCapabilitiesVersion: 2,
      }),
    };

    const response = await app.fetch(
      new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(403);
  });

  it('returns 404 with a restart hint when the instance is pre-cutover (v1)', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'ki_550e8400e29b41d4a716446655440000',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
        controllerCapabilitiesVersion: null,
      }),
    };

    const response = await app.fetch(
      new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/some/path?x=1'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Instance not available on this host',
      hint: 'This instance needs a restart before it can be reached at its per-instance hostname. Use the legacy URL for now.',
    });
  });

  it('also 404s pre-cutover instances when the v1 status has controllerCapabilitiesVersion=1 explicitly', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'ki_550e8400e29b41d4a716446655440000',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
        controllerCapabilitiesVersion: 1,
      }),
    };

    const response = await app.fetch(
      new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 for unparseable labels within the instance-host space', async () => {
    const response = await app.fetch(new Request('https://marketing.kiloclaw.ai/'), baseEnv(), {
      waitUntil: vi.fn(),
    } as never);

    expect(response.status).toBe(404);
  });

  it('returns 404 for multi-label subdomains within the instance-host space', async () => {
    const response = await app.fetch(new Request('https://foo.bar.kiloclaw.ai/'), baseEnv(), {
      waitUntil: vi.fn(),
    } as never);

    expect(response.status).toBe(404);
  });

  it('skips host-based routing for reserved labels (e.g. claw) and falls through', async () => {
    // `claw` is reserved for controller check-in + platform traffic that's
    // registered before the catch-all. A request hitting the catch-all on
    // `claw.kiloclaw.ai` means no earlier route matched — we want to fall
    // through to cookie/default routing rather than 404 with "Instance not
    // found" (the host-branch's response for unparseable labels), which
    // would be a misleading error for a reserved operational hostname.
    const instanceStub = {
      getStatus: vi.fn(),
    };
    const registryStub = {
      // Empty registry → default-personal path resolves no instance,
      // responds with "Instance not provisioned". Distinct from the
      // host-branch's "Instance not found".
      listInstances: vi.fn().mockResolvedValue([]),
    };
    const response = await app.fetch(
      new Request('https://claw.kiloclaw.ai/some-unhandled-path'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(404);
    // Host branch would have replied `{ error: 'Instance not found' }`;
    // the default branch replies `{ error: 'Instance not provisioned', ... }`.
    // The latter body proves the reserved-label short-circuit kicked in.
    await expect(response.json()).resolves.toMatchObject({
      error: 'Instance not provisioned',
    });
    // Host branch would have called the Instance DO's getStatus for the
    // `claw` label. It must not.
    expect(instanceStub.getStatus).not.toHaveBeenCalled();
  });

  it('returns 404 when the DO has no userId (instance never provisioned)', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: null,
        sandboxId: null,
        status: null,
        provider: null,
        runtimeId: null,
        flyMachineId: null,
        flyAppName: null,
        controllerCapabilitiesVersion: null,
      }),
    };

    const response = await app.fetch(
      new Request('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai/'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(404);
  });

  it('is case-insensitive on the host label', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'ki_550e8400e29b41d4a716446655440000',
        status: 'running',
        provider: 'fly',
        runtimeId: 'machine-1',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
        controllerCapabilitiesVersion: 2,
      }),
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
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const response = await app.fetch(
      new Request('https://I-550E8400E29B41D4A716446655440000.KILOCLAW.AI/'),
      {
        ...baseEnv(),
        KILOCLAW_INSTANCE: instanceNamespace,
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(200);
    expect(instanceNamespace.idFromName).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('works with a dev suffix including a port', async () => {
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'ki_550e8400e29b41d4a716446655440000',
        status: 'running',
        provider: 'docker-local',
        runtimeId: 'kiloclaw-sandbox-1',
        flyMachineId: null,
        flyAppName: null,
        controllerCapabilitiesVersion: 2,
      }),
      getRoutingTarget: vi.fn().mockResolvedValue({
        origin: 'http://127.0.0.1:45001',
        headers: {},
      }),
    };
    const fetchMock = vi.mocked(fetch) as FetchMock;
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const response = await app.fetch(
      new Request('http://i-550e8400e29b41d4a716446655440000.kiloclaw.localhost:8795/api/foo'),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.localhost:8795',
        KILOCLAW_INSTANCE_URL_SCHEME: 'http',
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

  it('falls through to cookie-based routing when the host does not match the suffix', async () => {
    // Host is `claw.kilosessions.ai` — doesn't match `.kiloclaw.ai` suffix,
    // so the host branch is skipped and the cookie branch (no cookie set)
    // falls through to the default registry lookup.
    const registryStub = {
      listInstances: vi.fn().mockResolvedValue([]),
    };

    const response = await app.fetch(
      new Request('https://claw.kilosessions.ai/'),
      {
        ...baseEnv(),
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn(),
          get: vi.fn(),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    // No instance exists for user-1 → default path returns 404.
    expect(response.status).toBe(404);
  });
});
