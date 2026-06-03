import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Env } from './types.js';

const {
  getRunningTerminalClientMock,
  consumeCloudAgentReportBatchMock,
  removeExpiredCloudAgentReportDataMock,
} = vi.hoisted(() => ({
  getRunningTerminalClientMock: vi.fn(),
  consumeCloudAgentReportBatchMock: vi.fn().mockResolvedValue(undefined),
  removeExpiredCloudAgentReportDataMock: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  getRunningTerminalClientMock.mockReset();
  consumeCloudAgentReportBatchMock.mockClear();
  removeExpiredCloudAgentReportDataMock.mockClear();
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
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${token}`,
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

    expect(response.status).toBe(409);
    expect(facadeFetch).not.toHaveBeenCalled();
  });

  it('rejects repeated producer identity parameters before session validation', async () => {
    const env = createEnv();
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperRunId=wr_2&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${token}`,
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
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2abc&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${token}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });
});
