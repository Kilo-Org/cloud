import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Env } from './types.js';
import { mintWrapperDispatchTicket, type WrapperDispatchTicketClaims } from './auth.js';

const {
  getRunningTerminalClientMock,
  consumeCloudAgentReportBatchMock,
  removeExpiredCloudAgentReportDataMock,
  requireCurrentSessionAccessMock,
} = vi.hoisted(() => ({
  getRunningTerminalClientMock: vi.fn(),
  consumeCloudAgentReportBatchMock: vi.fn().mockResolvedValue(undefined),
  removeExpiredCloudAgentReportDataMock: vi.fn().mockResolvedValue(undefined),
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('./logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);

  return {
    logger,
    withLogTags: async (_tags: unknown, fn: () => Promise<void>) => fn(),
    WithLogTags: () => (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) =>
      descriptor,
  };
});

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: vi.fn(),
}));

vi.mock('./agent-sandbox/factory.js', () => ({
  createAgentSandbox: vi.fn(() => ({
    getRunningTerminalClient: getRunningTerminalClientMock,
  })),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

vi.mock('./router.js', () => ({
  appRouter: {},
}));

vi.mock('./callbacks/index.js', () => ({
  createCallbackQueueConsumer: vi.fn(),
}));

vi.mock('./telemetry/report-consumer.js', () => ({
  CLOUD_AGENT_REPORT_QUEUE_NAMES: new Set([
    'cloud-agent-next-report-queue',
    'cloud-agent-next-report-queue-dev',
    'cloud-agent-next-report-queue-test',
  ]),
  consumeCloudAgentReportBatch: consumeCloudAgentReportBatchMock,
  removeExpiredCloudAgentReportData: removeExpiredCloudAgentReportDataMock,
}));

vi.mock('./middleware/auth.js', () => ({
  authMiddleware: vi.fn(),
}));

vi.mock('./middleware/balance.js', () => ({
  balanceMiddleware: vi.fn(),
}));

vi.mock('./session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
  projectSessionAccessHttpError: (error: unknown) =>
    new Response(
      error instanceof Error && 'code' in error && error.code === 'FORBIDDEN'
        ? 'Session access denied'
        : 'Session access is temporarily unavailable',
      {
        status: error instanceof Error && 'code' in error && error.code === 'FORBIDDEN' ? 403 : 503,
      }
    ),
}));

vi.mock('./persistence/CloudAgentSession.js', () => ({
  CloudAgentSession: class CloudAgentSession {},
}));

const { default: worker } = await import('./server.js');

const secret = 'test-secret';

type MockEnv = {
  NEXTAUTH_SECRET: string;
  Sandbox: unknown;
  SandboxSmall: unknown;
  WS_ALLOWED_ORIGINS?: string;
  CLOUD_AGENT_SESSION: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  USER_KILO_FACADE: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
};

function createEnv(): MockEnv {
  return {
    NEXTAUTH_SECRET: secret,
    Sandbox: {},
    SandboxSmall: {},
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
    USER_KILO_FACADE: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
  };
}

function fetchWorker(request: Request, env: MockEnv): Promise<Response> | Response {
  return worker.fetch(request, env as unknown as Env, {} as ExecutionContext);
}

function signKiloToken(userId = 'usr_1'): string {
  return jwt.sign(
    {
      version: 3,
      kiloUserId: userId,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

function signWrapperDispatchTicket(overrides: Partial<WrapperDispatchTicketClaims> = {}): string {
  return mintWrapperDispatchTicket(
    {
      type: 'wrapper_dispatch_ticket',
      userId: 'usr_feed',
      cloudAgentSessionId: 'agent_live',
      kiloSessionId: 'ses_12345678901234567890123456',
      wrapperRunId: 'wr_1',
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_1',
      ...overrides,
    },
    secret
  );
}

beforeEach(() => {
  getRunningTerminalClientMock.mockReset();
  consumeCloudAgentReportBatchMock.mockClear();
  removeExpiredCloudAgentReportDataMock.mockClear();
  requireCurrentSessionAccessMock.mockReset().mockResolvedValue({
    kiloSessionId: 'ses_12345678901234567890123456',
    organizationId: null,
  });
});

describe('server /stream', () => {
  it('returns Ticket expired before Durable Object lookup for expired tickets', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: -1 }
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/stream?cloudAgentSessionId=session-1&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Ticket expired');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.CLOUD_AGENT_SESSION.get).not.toHaveBeenCalled();
  });

  it('rejects a valid ticket when current session access has been removed', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        userId: 'user-1',
        kiloSessionId: 'ses_12345678901234567890123456',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const env = createEnv();
    requireCurrentSessionAccessMock.mockRejectedValue(
      Object.assign(new Error('Session access denied'), { code: 'FORBIDDEN' })
    );
    const request = new Request(
      `http://worker.test/stream?cloudAgentSessionId=session-1&ticket=${encodeURIComponent(ticket)}`,
      { headers: { Upgrade: 'websocket' } }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Session access denied');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.CLOUD_AGENT_SESSION.get).not.toHaveBeenCalled();
  });
});

describe('server background reporting', () => {
  it('routes report queue batches to the Cloud Agent report consumer', async () => {
    const env = createEnv();
    const batch = {
      queue: 'cloud-agent-next-report-queue',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env as unknown as Env);

    expect(consumeCloudAgentReportBatchMock).toHaveBeenCalledWith(batch, env);
  });

  it('routes report test queue batches to the Cloud Agent report consumer', async () => {
    const env = createEnv();
    const batch = {
      queue: 'cloud-agent-next-report-queue-test',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env as unknown as Env);

    expect(consumeCloudAgentReportBatchMock).toHaveBeenCalledWith(batch, env);
  });

  it('routes isolated development report queue batches to the Cloud Agent report consumer', async () => {
    const env = createEnv();
    const batch = {
      queue: 'cloud-agent-next-report-queue-dev',
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env as unknown as Env);

    expect(consumeCloudAgentReportBatchMock).toHaveBeenCalledWith(batch, env);
  });

  it('runs reporting retention cleanup from the scheduled handler', async () => {
    const env = createEnv();

    await worker.scheduled({} as ScheduledController, env as unknown as Env);

    expect(removeExpiredCloudAgentReportDataMock).toHaveBeenCalledWith(env);
  });
});

describe('server /terminal', () => {
  it('proxies valid terminal tickets directly to the wrapper container', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        ptyId: 'pty_123',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const env = createEnv();
    const sandboxId = `usr-${'a'.repeat(48)}`;
    const metadata = {
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'session-1',
        userId: 'user-1',
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {},
      workspace: {
        sandboxId,
        workspacePath: '/workspace/user/repo',
      },
      lifecycle: {
        version: 1,
        timestamp: Date.now(),
        preparedAt: Date.now(),
      },
    };
    const terminalResponse = new Response('proxied', { status: 200 });
    const connectTerminal = vi.fn().mockResolvedValueOnce(terminalResponse);
    getRunningTerminalClientMock.mockResolvedValue({
      status: 'ready',
      client: { connectTerminal },
    });
    const getMetadata = vi.fn().mockResolvedValue(metadata);
    const fetch = vi.fn();
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ fetch, getMetadata });

    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response).toBe(terminalResponse);
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('user-1:session-1');
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(getRunningTerminalClientMock).toHaveBeenCalledOnce();
    expect(connectTerminal).toHaveBeenCalledWith('pty_123', request);
  });

  it('rejects removed session access before Durable Object lookup', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        ptyId: 'pty_123',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    requireCurrentSessionAccessMock.mockRejectedValue(
      Object.assign(new Error('Session access denied'), { code: 'FORBIDDEN' })
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      { headers: { Upgrade: 'websocket' } }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.CLOUD_AGENT_SESSION.get).not.toHaveBeenCalled();
    expect(getRunningTerminalClientMock).not.toHaveBeenCalled();
  });

  it('rejects stream-purpose tickets', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'stream',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Invalid ticket purpose');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('rejects terminal tickets scoped to a different PTY', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        ptyId: 'pty_other',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('PTY mismatch');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('rejects disallowed WebSocket origins before looking up the session', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        ptyId: 'pty_123',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const env = createEnv();
    env.WS_ALLOWED_ORIGINS = 'https://app.example.com';
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: {
          Upgrade: 'websocket',
          Origin: 'https://evil.example.com',
        },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Origin not allowed');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });
});

describe('server /kilo facade route', () => {
  for (const path of ['/kilo', '/kilo/event']) {
    it(`returns 401 before facade dispatch when auth is missing for ${path}`, async () => {
      const env = createEnv();

      const response = await fetchWorker(new Request(`http://worker.test${path}`), env);

      expect(response.status).toBe(401);
      expect(env.USER_KILO_FACADE.idFromName).not.toHaveBeenCalled();
      expect(env.USER_KILO_FACADE.get).not.toHaveBeenCalled();
    });
  }

  it('routes the authenticated root facade path through its explicit registration', async () => {
    const env = createEnv();
    const facadeFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('facade root response', { status: 209 })
    );
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const token = signKiloToken('usr_facade');

    const response = await fetchWorker(
      new Request('http://worker.test/kilo', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(209);
    expect(facadeFetch).toHaveBeenCalledOnce();
    expect(new URL(facadeFetch.mock.calls[0][0].url).pathname).toBe('/kilo');
  });

  it('routes valid bearer-authenticated requests to the per-user facade without public credentials', async () => {
    const env = createEnv();
    const facadeFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('facade response', { status: 209 })
    );
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const token = signKiloToken('usr_facade');

    const response = await fetchWorker(
      new Request('http://worker.test/kilo/session/ses_12345678901234567890123456/message', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Cookie: 'session=secret',
          'Content-Type': 'application/json',
          'x-kilo-facade-user-id': 'usr_attacker',
          'x-kilo-facade-auth-token': 'attacker-token',
        },
        body: JSON.stringify({ ok: true }),
      }),
      env
    );

    expect(response.status).toBe(209);
    expect(env.USER_KILO_FACADE.idFromName).toHaveBeenCalledWith('usr_facade');
    expect(env.USER_KILO_FACADE.get).toHaveBeenCalledWith('facade-id');
    expect(facadeFetch).toHaveBeenCalledOnce();

    const forwarded = facadeFetch.mock.calls[0][0];
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('x-kilo-facade-user-id')).toBe('usr_facade');
    expect(forwarded.headers.get('x-kilo-facade-auth-token')).toBe(token);
    expect(forwarded.headers.get('content-type')).toBe('application/json');
    await expect(forwarded.text()).resolves.toBe('{"ok":true}');
  });
});

describe('server raw global feed route', () => {
  it('validates producer fencing and forwards accepted producer WebSockets to the user facade', async () => {
    const env = createEnv();
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ validateKiloGlobalFeedProducer });
    const facadeFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('accepted', { status: 200 })
    );
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${ticket}`,
            Cookie: 'session=secret',
            'x-kilo-facade-user-id': 'usr_attacker',
            'x-kilo-facade-auth-token': 'attacker-token',
          },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('usr_feed:agent_live');
    expect(validateKiloGlobalFeedProducer).toHaveBeenCalledWith({
      kiloSessionId: 'ses_12345678901234567890123456',
      wrapperRunId: 'wr_1',
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_1',
    });

    const forwarded = facadeFetch.mock.calls[0][0];
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.pathname).toBe('/internal/kilo/global-feed');
    expect(forwardedUrl.searchParams.get('userId')).toBe('usr_feed');
    expect(forwardedUrl.searchParams.get('cloudAgentSessionId')).toBe('agent_live');
    expect(forwardedUrl.searchParams.get('kiloSessionId')).toBe('ses_12345678901234567890123456');
    expect(forwarded.headers.get('upgrade')).toBe('websocket');
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('x-kilo-facade-user-id')).toBeNull();
    expect(forwarded.headers.get('x-kilo-facade-auth-token')).toBeNull();
  });

  it('rejects stale producer fencing before facade dispatch', async () => {
    const env = createEnv();
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      validateKiloGlobalFeedProducer: vi.fn(async () => ({
        success: false as const,
        status: 409,
        message: 'Stale wrapper connection',
      })),
    });
    const facadeFetch = vi.fn();
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${ticket}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(409);
    expect(facadeFetch).not.toHaveBeenCalled();
  });

  it('rejects repeated producer identity parameters before session validation', async () => {
    const env = createEnv();
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperRunId=wr_2&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${ticket}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('rejects malformed producer generation before session validation', async () => {
    const env = createEnv();
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2abc&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${ticket}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('accepts a legacy raw Kilo JWT for wrapper processes bound before dispatch tickets shipped', async () => {
    const env = createEnv();
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ validateKiloGlobalFeedProducer });
    const facadeFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('accepted', { status: 200 })
    );
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${token}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('usr_feed:agent_live');
    expect(validateKiloGlobalFeedProducer).toHaveBeenCalledWith({
      kiloSessionId: 'ses_12345678901234567890123456',
      wrapperRunId: 'wr_1',
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_1',
    });
  });

  it('rejects a ticket whose fence claims disagree with the request query', async () => {
    const env = createEnv();
    const ticket = signWrapperDispatchTicket({ wrapperRunId: 'wr_stale' });

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${ticket}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Ticket does not match dispatch fence');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });
});

describe('server wrapper ingest route', () => {
  it('accepts a valid wrapper dispatch ticket and forwards to the session Durable Object', async () => {
    const env = createEnv();
    const doFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ fetch: doFetch });
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: { Upgrade: 'websocket', Authorization: `Bearer ${ticket}` },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('usr_feed:agent_live');
    expect(doFetch).toHaveBeenCalledOnce();
    expect(new URL(doFetch.mock.calls[0][0].url).pathname).toBe('/ingest');
  });

  it('accepts a legacy raw Kilo JWT for wrapper processes bound before dispatch tickets shipped', async () => {
    const env = createEnv();
    const doFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ fetch: doFetch });
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/agent_live/ingest', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('usr_feed:agent_live');
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it('rejects a ticket minted for a different user', async () => {
    const env = createEnv();
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_other/agent_live/ingest', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${ticket}` },
      }),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Token does not match session user');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('rejects a ticket whose fence claims disagree with the request query', async () => {
    const env = createEnv();
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=99&wrapperConnectionId=conn_1',
        {
          headers: { Upgrade: 'websocket', Authorization: `Bearer ${ticket}` },
        }
      ),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Ticket does not match dispatch fence');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });
});

describe('server wrapper log upload route', () => {
  function createLogEnv() {
    const env = createEnv();
    return Object.assign(env, {
      R2_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
    });
  }

  it('accepts a valid wrapper dispatch ticket and stores the upload in R2', async () => {
    const env = createLogEnv();
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/logs/session/logs.tar.gz?kiloSessionId=ses_12345678901234567890123456',
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${ticket}` },
          body: new Uint8Array([1, 2, 3]),
        }
      ),
      env
    );

    expect(response.status).toBe(204);
    expect(env.R2_BUCKET.put).toHaveBeenCalledOnce();
    expect(env.R2_BUCKET.put.mock.calls[0][0]).toBe('logs/usr_feed/agent_live/session/logs.tar.gz');
  });

  it('accepts a legacy raw Kilo JWT for wrapper processes bound before dispatch tickets shipped', async () => {
    const env = createLogEnv();
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/logs/session/logs.tar.gz?kiloSessionId=ses_12345678901234567890123456',
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: new Uint8Array([1, 2, 3]),
        }
      ),
      env
    );

    expect(response.status).toBe(204);
    expect(env.R2_BUCKET.put).toHaveBeenCalledOnce();
  });

  it('accepts the old legacy log upload URL without a kiloSessionId query parameter', async () => {
    const env = createLogEnv();
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/agent_live/logs/session/logs.tar.gz', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: new Uint8Array([1, 2, 3]),
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'usr_feed',
      cloudAgentSessionId: 'agent_live',
    });
    expect(env.R2_BUCKET.put).toHaveBeenCalledOnce();
    expect(env.R2_BUCKET.put.mock.calls[0][0]).toBe('logs/usr_feed/agent_live/session/logs.tar.gz');
  });

  it('rejects an upload missing the kiloSessionId parameter', async () => {
    const env = createLogEnv();
    const ticket = signWrapperDispatchTicket();

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/agent_live/logs/session/logs.tar.gz', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ticket}` },
        body: new Uint8Array([1, 2, 3]),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
  });

  it('rejects a ticket whose kiloSessionId disagrees with the request query', async () => {
    const env = createLogEnv();
    const ticket = signWrapperDispatchTicket({ kiloSessionId: 'ses_other0000000000000000000' });

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/logs/session/logs.tar.gz?kiloSessionId=ses_12345678901234567890123456',
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${ticket}` },
          body: new Uint8Array([1, 2, 3]),
        }
      ),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Ticket does not match dispatch fence');
    expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
  });
});
