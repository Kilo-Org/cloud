import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { VERCEL_SANDBOX_UNAVAILABLE_MESSAGE } from './agent-sandbox/vercel/vercel-agent-sandbox.js';
import type { Env } from './types.js';
import { mintWrapperDispatchTicket, type WrapperDispatchTicketClaims } from './auth.js';
import { mintControlLogUploadGrant } from './sandbox-control/log-upload-grant.js';
import {
  createRuntimeProxyGrant,
  createWorktreeRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
  issueWorktreeRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import {
  RUNTIME_PROXY_ATTESTATION_HEADER,
  verifyRuntimeProxyAttestation,
} from '@kilocode/worker-utils/runtime-proxy-attestation';

const {
  getRunningTerminalClientMock,
  consumeCloudAgentReportBatchMock,
  removeExpiredCloudAgentReportDataMock,
  requireCurrentSessionAccessMock,
  getPgDbMock,
} = vi.hoisted(() => ({
  getRunningTerminalClientMock: vi.fn(),
  consumeCloudAgentReportBatchMock: vi.fn().mockResolvedValue(undefined),
  removeExpiredCloudAgentReportDataMock: vi.fn().mockResolvedValue(undefined),
  requireCurrentSessionAccessMock: vi.fn(),
  getPgDbMock: vi.fn(),
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

vi.mock('./persistence/SandboxControl.js', () => ({
  SandboxControl: class SandboxControl {},
}));

vi.mock('./sandbox-session/SandboxSession.js', () => ({
  SandboxSession: class SandboxSession {},
}));

vi.mock('./db/pg.js', () => ({
  getPgDb: getPgDbMock,
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: null, blocked_reason: null }],
        }),
      }),
    }),
  }),
}));

const { default: worker } = await import('./server.js');

const secret = 'test-secret';

type MockEnv = {
  NEXTAUTH_SECRET: string;
  Sandbox: unknown;
  SandboxSmall: unknown;
  WS_ALLOWED_ORIGINS?: string;
  HYPERDRIVE: { connectionString: string };
  INTERNAL_API_SECRET?: string;
  CLOUD_AGENT_SESSION: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  USER_KILO_FACADE: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  STREAM_TICKET_NONCE_DO: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  SANDBOX_CONTROL: {
    getByName: ReturnType<typeof vi.fn>;
  };
  SANDBOX_SESSION: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
};

function createEnv(): MockEnv {
  return {
    NEXTAUTH_SECRET: secret,
    Sandbox: {},
    SandboxSmall: {},
    HYPERDRIVE: { connectionString: 'postgres://test' },
    INTERNAL_API_SECRET: 'test-internal-secret',
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(),
      get: vi.fn(() => ({ getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue('legacy') })),
    },
    USER_KILO_FACADE: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
    STREAM_TICKET_NONCE_DO: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
    SANDBOX_CONTROL: {
      getByName: vi.fn(),
    },
    SANDBOX_SESSION: {
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

function signKiloTokenWithAudience(audience: string | string[], userId = 'usr_1'): string {
  return jwt.sign(
    {
      version: 3,
      kiloUserId: userId,
      aud: audience,
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

function signTerminalTicket(
  cloudAgentSessionId: string,
  overrides: Record<string, unknown> = {}
): string {
  return jwt.sign(
    {
      type: 'stream_ticket',
      purpose: 'terminal',
      userId: 'user-1',
      cloudAgentSessionId,
      ptyId: 'pty_123',
      nonce: 'nonce-1',
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
  );
}

function installTerminalNonceConsumer(env: MockEnv) {
  const consume = vi.fn().mockResolvedValue(true);
  env.STREAM_TICKET_NONCE_DO.idFromName.mockReturnValue('nonce-do-id');
  env.STREAM_TICKET_NONCE_DO.get.mockReturnValue({ consume });
  return consume;
}

beforeEach(() => {
  getRunningTerminalClientMock.mockReset();
  consumeCloudAgentReportBatchMock.mockClear();
  removeExpiredCloudAgentReportDataMock.mockClear();
  getPgDbMock.mockReset();
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
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-stream' }
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
  it('validates control-plane terminal tickets before selecting the session Durable Object', async () => {
    const sessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const env = createEnv();
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=${sessionId}&ptyId=pty_123&ticket=unused`,
      { headers: { Upgrade: 'websocket' } }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Invalid ticket signature');
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
    expect(env.STREAM_TICKET_NONCE_DO.idFromName).not.toHaveBeenCalled();
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('forwards authorized control-plane browser upgrades without tickets or browser credentials', async () => {
    const sessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ticket = signTerminalTicket(sessionId, {
      organizationId: 'org-1',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const env = createEnv();
    env.WS_ALLOWED_ORIGINS = 'https://app.example.com';
    const consume = installTerminalNonceConsumer(env);
    const sessionResponse = new Response('bridged', { status: 200 });
    const sessionFetch = vi.fn().mockResolvedValue(sessionResponse);
    env.SANDBOX_SESSION.idFromName.mockReturnValue('sandbox-session-do-id');
    env.SANDBOX_SESSION.get.mockReturnValue({ fetch: sessionFetch });
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=${sessionId}&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}&role=wrapper&ownerId=attacker`,
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Protocol': 'private-browser-protocol',
          'Sec-WebSocket-Extensions': 'permessage-deflate',
          Origin: 'https://app.example.com',
          Authorization: 'Bearer browser-secret',
          Cookie: 'session=browser-secret',
          'X-Terminal-Role': 'wrapper',
          'X-Internal-Role': 'wrapper',
          'X-Forwarded-User': 'attacker',
        },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response).toBe(sessionResponse);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'user-1',
      cloudAgentSessionId: sessionId,
      expectedOrganizationId: 'org-1',
      expectedKiloSessionId: 'ses_12345678901234567890123456',
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(`user-1:${sessionId}`);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(getRunningTerminalClientMock).not.toHaveBeenCalled();
    expect(sessionFetch).toHaveBeenCalledOnce();

    const forwarded = sessionFetch.mock.calls[0]?.[0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwarded).not.toBe(request);
    expect(forwardedUrl.pathname).toBe('/terminal/browser');
    expect(forwardedUrl.search).toBe('?ptyId=pty_123');
    expect(forwarded.headers.get('upgrade')).toBe('websocket');
    expect(forwarded.headers.get('connection')).toBe('Upgrade');
    expect(forwarded.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(forwarded.headers.get('sec-websocket-version')).toBe('13');
    expect(forwarded.headers.get('sec-websocket-protocol')).toBeNull();
    expect(forwarded.headers.get('sec-websocket-extensions')).toBeNull();
    expect(forwarded.headers.get('origin')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('x-terminal-role')).toBeNull();
    expect(forwarded.headers.get('x-internal-role')).toBeNull();
    expect(forwarded.headers.get('x-forwarded-user')).toBeNull();
  });

  it('rejects revoked control-plane access before consuming the browser ticket nonce', async () => {
    const sessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ticket = signTerminalTicket(sessionId);
    const env = createEnv();
    requireCurrentSessionAccessMock.mockRejectedValue(
      Object.assign(new Error('Session access denied'), { code: 'FORBIDDEN' })
    );

    const response = await fetchWorker(
      new Request(
        `http://worker.test/terminal?cloudAgentSessionId=${sessionId}&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
        { headers: { Upgrade: 'websocket' } }
      ),
      env
    );

    expect(response.status).toBe(403);
    expect(env.STREAM_TICKET_NONCE_DO.idFromName).not.toHaveBeenCalled();
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it.each(['pty.invalid', 'pty/invalid', 'a'.repeat(129)])(
    'rejects invalid browser PTY identifiers before ticket validation: %s',
    async ptyId => {
      const sessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const env = createEnv();
      const url = new URL('http://worker.test/terminal');
      url.searchParams.set('cloudAgentSessionId', sessionId);
      url.searchParams.set('ptyId', ptyId);
      url.searchParams.set('ticket', 'unused');

      const response = await fetchWorker(
        new Request(url, { headers: { Upgrade: 'websocket' } }),
        env
      );

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe('Invalid ptyId parameter');
      expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
      expect(env.STREAM_TICKET_NONCE_DO.idFromName).not.toHaveBeenCalled();
      expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    }
  );

  it('proxies valid terminal tickets directly to the wrapper container', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        ptyId: 'pty_123',
        nonce: 'nonce-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
    );
    const env = createEnv();
    env.STREAM_TICKET_NONCE_DO.idFromName.mockReturnValue('nonce-do-id');
    env.STREAM_TICKET_NONCE_DO.get.mockReturnValue({
      consume: vi.fn().mockResolvedValue(true),
    });
    const metadata = {
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'session-1',
        userId: 'user-1',
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {},
      workspace: {
        sandboxId: `usr-${'a'.repeat(48)}`,
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
    expect(connectTerminal).toHaveBeenCalledTimes(1);
    const connectRequest = connectTerminal.mock.calls[0]?.[1];
    expect(connectRequest).toBeInstanceOf(Request);
    expect(new URL((connectRequest as Request).url).pathname).toBe('/terminal');
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
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
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

  it('returns the explicit provider capability error for Vercel terminal transport', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        ptyId: 'pty_123',
        nonce: 'nonce-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
    );
    const env = createEnv();
    env.STREAM_TICKET_NONCE_DO.idFromName.mockReturnValue('nonce-do-id');
    env.STREAM_TICKET_NONCE_DO.get.mockReturnValue({
      consume: vi.fn().mockResolvedValue(true),
    });
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      getMetadata: vi.fn().mockResolvedValue({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: 'session-1',
          userId: 'user-1',
          createdOnPlatform: 'cloud-agent-web',
        },
        auth: {},
        workspace: { sandboxId: 'ses-vercel', sandboxProvider: 'vercel', workspacePath: '/repo' },
        lifecycle: { version: 1, timestamp: 1, preparedAt: 1 },
      }),
    });
    getRunningTerminalClientMock.mockResolvedValue({
      status: 'capability-unavailable',
      message: VERCEL_SANDBOX_UNAVAILABLE_MESSAGE,
    });
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      { headers: { Upgrade: 'websocket' } }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe(VERCEL_SANDBOX_UNAVAILABLE_MESSAGE);
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
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
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
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
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

describe('server runtime credential proxy', () => {
  async function handle(): Promise<string> {
    return issueRuntimeCredentialProxyHandle(
      { NEXTAUTH_SECRET: secret } as never,
      createRuntimeProxyGrant({
        plane: 'legacy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'agent_proxy',
        kiloSessionId: 'kilo_proxy',
        userId: 'usr_proxy',
        orgId: 'org_proxy',
        mode: 'contained',
        generation: 1,
        allocationId: 'allocation_proxy',
        wrapperRunId: 'run_proxy',
        wrapperConnectionId: 'connection_proxy',
        leaseExpiresAt: Date.now() + 60_000,
        state: 'active',
      })
    );
  }

  it('denies invalid handles before resolving a session or fetching', async () => {
    const env = createEnv();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await fetchWorker(
      new Request('https://worker.test/api/runtime-credential-proxy/provider/models', {
        headers: { Authorization: 'Bearer invalid' },
      }),
      env
    );
    expect(response.status).toBe(401);
    expect(env.CLOUD_AGENT_SESSION.get).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('routes verified facade requests and leaves non-handles to ordinary routing', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test' });
    const resolve = vi.fn().mockResolvedValue({
      token: 'https://api.kilo.ai:backing-token',
      organizationId: 'org_proxy',
      runtimeAuthorization: {
        userId: 'usr_proxy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        resourceId: 'agent_proxy',
      },
    });
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ resolveRuntimeCredentialProxyGrant: resolve });
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const authorization = `Bearer ${await handle()}`;
      const requests = [
        ['GET', '/api/profile', undefined],
        ['GET', '/api/defaults', undefined],
        ['GET', '/api/openrouter/models', undefined],
        ['POST', '/api/openrouter/chat/completions', '{}'],
        ['POST', '/api/gateway/chat/completions', '{}'],
        ['POST', '/api/gateway/v1/chat/completions', '{}'],
        ['POST', '/api/gateway/v1/responses', '{}'],
        ['POST', '/api/session', '{"sessionId":"kilo_proxy"}'],
        ['GET', '/api/session/kilo_proxy/export', undefined],
        ['POST', '/api/session/kilo_proxy/ingest', '{}'],
        ['POST', '/api/session/kilo_proxy/title', '{}'],
      ] as const;
      for (const [method, path, body] of requests) {
        const response = await fetchWorker(
          new Request(`https://worker.test${path}`, {
            method,
            headers: {
              Authorization: authorization,
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body }),
          }),
          env
        );
        expect(response.status).toBe(200);
      }
      expect(
        upstream.mock.calls.map(([request]) => new URL((request as Request).url).pathname)
      ).toEqual([
        '/api/profile',
        '/api/defaults',
        '/api/gateway/models',
        '/api/gateway/chat/completions',
        '/api/gateway/chat/completions',
        '/api/gateway/v1/chat/completions',
        '/api/gateway/v1/responses',
        '/api/session',
        '/api/session/kilo_proxy/export',
        '/api/session/kilo_proxy/ingest',
        '/api/session/kilo_proxy/title',
      ]);
      const createRequest = upstream.mock.calls[7]?.[0] as Request;
      expect(await createRequest.text()).toBe('{"sessionId":"kilo_proxy"}');

      const invalid = await fetchWorker(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: 'Bearer invalid' },
        }),
        env
      );
      const unknown = await fetchWorker(
        new Request('https://worker.test/api/not-allowed', {
          headers: { Authorization: authorization },
        }),
        env
      );
      expect(invalid.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(upstream).toHaveBeenCalledTimes(requests.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recognizes only paths under a safe configured facade prefix', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test/runtime' });
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      resolveRuntimeCredentialProxyGrant: vi.fn().mockResolvedValue({
        token: 'https://api.kilo.ai:backing-token',
        runtimeAuthorization: {
          userId: 'usr_proxy',
          authorizationId: '11111111-1111-4111-8111-111111111111',
          resourceId: 'agent_proxy',
        },
      }),
    });
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const authorization = `Bearer ${await handle()}`;
      expect(
        (
          await fetchWorker(
            new Request('https://worker.test/runtime/api/profile', {
              headers: { Authorization: authorization },
            }),
            env
          )
        ).status
      ).toBe(200);
      expect(
        (
          await fetchWorker(
            new Request('https://worker.test/api/profile', {
              headers: { Authorization: authorization },
            }),
            env
          )
        ).status
      ).toBe(404);
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('replaces caller credentials, enforces organization identity, and preserves request shape', async () => {
    const env = createEnv();
    const resolve = vi.fn().mockResolvedValue({
      token: 'https://provider.example.test/api/openrouter:backing-token',
      organizationId: 'org_proxy',
      runtimeAuthorization: {
        userId: 'usr_proxy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        resourceId: 'agent_proxy',
      },
    });
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ resolveRuntimeCredentialProxyGrant: resolve });
    const upstream = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/api/openrouter/chat/completions');
      expect(await request.text()).toBe('{"stream":true}');
      expect(request.headers.get('authorization')).toMatch(/^Bearer /);
      expect(request.headers.get('authorization')).not.toBe('Bearer caller-token');
      expect(request.headers.get(RUNTIME_PROXY_ATTESTATION_HEADER)).not.toBe(
        'caller-supplied-proof'
      );
      expect(request.headers.get('cookie')).toBeNull();
      expect(request.headers.get('x-kilocode-organizationid')).toBe('org_proxy');
      await expect(
        verifyRuntimeProxyAttestation({
          value: request.headers.get(RUNTIME_PROXY_ATTESTATION_HEADER),
          secret,
          audience: 'kilo-gateway',
          userId: 'usr_proxy',
          authorizationId: '11111111-1111-4111-8111-111111111111',
          resourceId: 'agent_proxy',
          bearer: 'https://provider.example.test/api/openrouter:backing-token',
        })
      ).resolves.toBe(true);
      return new Response('stream-body', {
        status: 307,
        headers: { Location: 'https://other.test' },
      });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await fetchWorker(
      new Request(
        'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/chat/completions?stream=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await handle()}`,
            Cookie: 'session=caller',
            'X-Kilocode-OrganizationId': 'attacker-org',
            [RUNTIME_PROXY_ATTESTATION_HEADER]: 'caller-supplied-proof',
            'Content-Type': 'application/json',
          },
          body: '{"stream":true}',
        }
      ),
      env
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://other.test');
    await expect(response.text()).resolves.toBe('stream-body');
    expect(resolve).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('removes every adjacent prohibited header before injecting runtime credentials', async () => {
    const env = createEnv();
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      resolveRuntimeCredentialProxyGrant: vi.fn().mockResolvedValue({
        token: 'https://provider.example.test/api/openrouter:backing-token',
        organizationId: 'org_proxy',
        runtimeAuthorization: {
          userId: 'usr_proxy',
          authorizationId: '11111111-1111-4111-8111-111111111111',
          resourceId: 'agent_proxy',
        },
      }),
    });
    const prohibited = [
      'forwarded',
      'proxy-connection',
      'proxy-a',
      'proxy-b',
      'x-forwarded-a',
      'x-forwarded-b',
      'x-internal-a',
      'x-internal-b',
      'x-kilo-a',
      'x-kilo-b',
      'x-kilocode-a',
      'x-kilocode-b',
      'x-real-ip',
    ];
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request(
          'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/models',
          {
            headers: {
              ...Object.fromEntries(prohibited.map(name => [name, 'untrusted'])),
              Authorization: `Bearer ${await handle()}`,
              'X-Kilocode-OrganizationId': 'attacker-org',
              'X-Client-Request-Id': 'request_proxy',
            },
          }
        ),
        env
      );
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
      const forwarded = upstream.mock.calls[0][0] as Request;
      for (const name of prohibited) expect(forwarded.headers.get(name)).toBeNull();
      expect(forwarded.headers.get('authorization')).toBe(
        'Bearer https://provider.example.test/api/openrouter:backing-token'
      );
      expect(forwarded.headers.get('x-kilocode-organizationid')).toBe('org_proxy');
      expect(forwarded.headers.get('x-client-request-id')).toBe('request_proxy');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes generic caller credential headers before injecting runtime credentials', async () => {
    const env = createEnv();
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      resolveRuntimeCredentialProxyGrant: vi.fn().mockResolvedValue({
        token: 'https://provider.example.test/api/openrouter:backing-token',
        runtimeAuthorization: {
          userId: 'usr_proxy',
          authorizationId: '11111111-1111-4111-8111-111111111111',
          resourceId: 'agent_proxy',
        },
      }),
    });
    const callerCredentials = ['x-api-key', 'api-key', 'x-auth-token'];
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request(
          'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/models',
          {
            headers: {
              ...Object.fromEntries(callerCredentials.map(name => [name, 'caller-credential'])),
              Authorization: `Bearer ${await handle()}`,
            },
          }
        ),
        env
      );
      expect(response.status).toBe(200);
      const forwarded = upstream.mock.calls[0][0] as Request;
      for (const name of callerCredentials) expect(forwarded.headers.get(name)).toBeNull();
      expect(forwarded.headers.get('authorization')).toBe(
        'Bearer https://provider.example.test/api/openrouter:backing-token'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes unsafe upstream response headers while preserving redirects and streaming', async () => {
    const env = createEnv();
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      resolveRuntimeCredentialProxyGrant: vi.fn().mockResolvedValue({
        token: 'https://provider.example.test/api/openrouter:backing-token',
        runtimeAuthorization: {
          userId: 'usr_proxy',
          authorizationId: '11111111-1111-4111-8111-111111111111',
          resourceId: 'agent_proxy',
        },
      }),
    });
    const unsafeHeaders = [
      'connection',
      'proxy-connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'set-cookie',
    ];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stream-body'));
        controller.close();
      },
    });
    const upstream = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 307,
        statusText: 'Temporary Redirect',
        headers: {
          ...Object.fromEntries(unsafeHeaders.map(name => [name, 'unsafe'])),
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          location: 'https://other.test/continue',
          [RUNTIME_PROXY_ATTESTATION_HEADER]: 'upstream-proof',
        },
      })
    );
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request(
          'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/models',
          { headers: { Authorization: `Bearer ${await handle()}` } }
        ),
        env
      );
      expect(response.status).toBe(307);
      expect(response.statusText).toBe('Temporary Redirect');
      expect(response.headers.get('location')).toBe('https://other.test/continue');
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      for (const name of unsafeHeaders) expect(response.headers.get(name)).toBeNull();
      expect(response.headers.get(RUNTIME_PROXY_ATTESTATION_HEADER)).toBeNull();
      await expect(response.text()).resolves.toBe('stream-body');
      expect(upstream.mock.calls[0][1]).toEqual({ redirect: 'manual' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards packaged CLI inference requests to the production gateway', async () => {
    const env = createEnv();
    const resolve = vi.fn().mockResolvedValue({
      token: jwt.sign({ exp: 4_000_000_000 }, secret),
      runtimeAuthorization: {
        userId: 'usr_proxy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        resourceId: 'agent_proxy',
      },
    });
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ resolveRuntimeCredentialProxyGrant: resolve });
    const upstream = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.kilo.ai/api/gateway/chat/completions?stream=true');
      return new Response('ok');
    });
    vi.stubGlobal('fetch', upstream);

    const response = await fetchWorker(
      new Request(
        'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/chat/completions?stream=true',
        { method: 'POST', headers: { Authorization: `Bearer ${await handle()}` } }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('uses a later active worktree member when the first member is revoked', async () => {
    const env = createEnv();
    const worktreeHandle = await issueWorktreeRuntimeCredentialProxyHandle(
      { NEXTAUTH_SECRET: secret } as never,
      createWorktreeRuntimeProxyGrant({
        sandboxId: 'sandbox_proxy',
        scopeId: 'worktree_11111111-1111-4111-8111-111111111111',
        directory: '/workspace/worktree',
        userId: 'usr_proxy',
        leaseExpiresAt: Date.now() + 60_000,
        state: 'active',
        allocationId: 'allocation_proxy',
        providerInstanceId: 'provider_proxy',
        connectionId: 'connection_proxy',
        wrapperInstanceId: 'wrapper_proxy',
      })
    );
    const candidates = [
      { sessionId: 'agent_revoked', kiloSessionId: 'kilo_revoked', handle: 'revoked-handle' },
      { sessionId: 'agent_active', kiloSessionId: 'kilo_active', handle: 'active-handle' },
    ];
    const resolveMembers = vi.fn().mockResolvedValue(candidates);
    const resolveCredential = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        token: jwt.sign({ exp: 4_000_000_000 }, secret),
        runtimeAuthorization: {
          userId: 'usr_proxy',
          authorizationId: '11111111-1111-4111-8111-111111111111',
          resourceId: 'agent_proxy',
        },
      });
    env.SANDBOX_CONTROL.getByName.mockReturnValue({
      resolveWorktreeRuntimeCredentialProxyGrant: resolveMembers,
    });
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      resolveRuntimeCredentialProxyGrant: resolveCredential,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

    const response = await fetchWorker(
      new Request(
        'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/chat/completions?stream=true',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${worktreeHandle}` },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(env.SANDBOX_CONTROL.getByName).toHaveBeenCalledWith('sandbox_proxy');
    expect(resolveMembers).toHaveBeenCalledWith({ handle: worktreeHandle });
    expect(resolveCredential).toHaveBeenNthCalledWith(1, 'revoked-handle');
    expect(resolveCredential).toHaveBeenNthCalledWith(2, 'active-handle');
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenNthCalledWith(
      1,
      'usr_proxy:agent_revoked'
    );
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenNthCalledWith(2, 'usr_proxy:agent_active');
    vi.unstubAllGlobals();
  });

  it('denies generic worktree access when every routed member fails validation', async () => {
    const env = createEnv();
    const worktreeHandle = await issueWorktreeRuntimeCredentialProxyHandle(
      { NEXTAUTH_SECRET: secret } as never,
      createWorktreeRuntimeProxyGrant({
        sandboxId: 'sandbox_proxy',
        scopeId: 'worktree_11111111-1111-4111-8111-111111111111',
        directory: '/workspace/worktree',
        userId: 'usr_proxy',
        leaseExpiresAt: Date.now() + 60_000,
        state: 'active',
        allocationId: 'allocation_proxy',
        providerInstanceId: 'provider_proxy',
        connectionId: 'connection_proxy',
        wrapperInstanceId: 'wrapper_proxy',
      })
    );
    env.SANDBOX_CONTROL.getByName.mockReturnValue({
      resolveWorktreeRuntimeCredentialProxyGrant: vi.fn().mockResolvedValue([
        { sessionId: 'agent_one', kiloSessionId: 'kilo_one', handle: 'invalid-one' },
        { sessionId: 'agent_two', kiloSessionId: 'kilo_two', handle: 'invalid-two' },
      ]),
    });
    const resolveCredential = vi.fn().mockResolvedValue(null);
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      resolveRuntimeCredentialProxyGrant: resolveCredential,
    });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const response = await fetchWorker(
      new Request(
        'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/chat/completions',
        { method: 'POST', headers: { Authorization: `Bearer ${worktreeHandle}` } }
      ),
      env
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Unauthorized');
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(upstream).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('validates the body-bound ingest identity before fetching upstream', async () => {
    const env = createEnv();
    const resolve = vi.fn().mockResolvedValue({
      token: jwt.sign({ exp: 4_000_000_000 }, secret),
      runtimeAuthorization: {
        userId: 'usr_proxy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        resourceId: 'agent_proxy',
      },
    });
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ resolveRuntimeCredentialProxyGrant: resolve });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await fetchWorker(
      new Request('https://worker.test/api/runtime-credential-proxy/ingest/api/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await handle()}`, 'Content-Type': 'application/json' },
        body: '{"sessionId":"other"}',
      }),
      env
    );
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  it.each([
    ['a matching audience string', 'cloud-agent-next'],
    ['a matching audience array', ['another-resource', 'cloud-agent-next']],
  ])('accepts $0 before routing through the facade', async (_name, audience) => {
    const env = createEnv();
    const facadeFetch = vi.fn().mockResolvedValue(new Response('facade response', { status: 209 }));
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const token = signKiloTokenWithAudience(audience, 'usr_facade');

    const response = await fetchWorker(
      new Request('http://worker.test/kilo', { headers: { Authorization: `Bearer ${token}` } }),
      env
    );

    expect(response.status).toBe(209);
    expect(env.USER_KILO_FACADE.idFromName).toHaveBeenCalledWith('usr_facade');
    expect(facadeFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['a different explicit audience', 'another-resource'],
    ['a malformed explicit audience', []],
  ])('rejects $0 before facade dispatch', async (_name, audience) => {
    const env = createEnv();
    const token = signKiloTokenWithAudience(audience, 'usr_facade');

    const response = await fetchWorker(
      new Request('http://worker.test/kilo', { headers: { Authorization: `Bearer ${token}` } }),
      env
    );

    expect(response.status).toBe(401);
    expect(env.USER_KILO_FACADE.idFromName).not.toHaveBeenCalled();
    expect(env.USER_KILO_FACADE.get).not.toHaveBeenCalled();
  });

  it('routes valid bearer-authenticated requests to the per-user facade without public credentials', async () => {
    const env = createEnv();
    const facadeFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('facade response', { status: 209 })
    );
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const token = signKiloToken('usr_facade');

    const request = new Request(
      'http://worker.test/kilo/session/ses_12345678901234567890123456/message',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Cookie: 'session=secret',
          'Content-Type': 'application/json',
          'x-kilo-facade-user-id': 'usr_attacker',
          'x-kilo-facade-auth-token': 'attacker-token',
        },
        body: JSON.stringify({ ok: true }),
      }
    );
    const response = await fetchWorker(request, env);

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
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(request.headers.get('cookie')).toBe('session=secret');
    expect(request.headers.get('x-kilo-facade-user-id')).toBe('usr_attacker');
    expect(request.headers.get('x-kilo-facade-auth-token')).toBe('attacker-token');
  });
});

describe('server raw global feed route', () => {
  it.each([
    ['a different audience', 'another-resource'],
    ['the Cloud Agent Next audience string', 'cloud-agent-next'],
    ['an audience array containing Cloud Agent Next', ['another-resource', 'cloud-agent-next']],
  ])(
    'rejects a raw Kilo JWT with $0 before session access or facade dispatch',
    async (_name, audience) => {
      const env = createEnv();
      const token = signKiloTokenWithAudience(audience, 'usr_feed');

      const response = await fetchWorker(
        new Request(
          'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
          { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } }
        ),
        env
      );

      expect(response.status).toBe(401);
      expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
      expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
      expect(env.USER_KILO_FACADE.idFromName).not.toHaveBeenCalled();
    }
  );

  it('rejects a raw Kilo JWT with a malformed explicit audience before session access', async () => {
    const env = createEnv();
    const token = signKiloTokenWithAudience([], 'usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('accepts an audience-less legacy raw Kilo JWT through producer fencing', async () => {
    const env = createEnv();
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const facadeFetch = vi.fn().mockResolvedValue(new Response('accepted', { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      validateKiloGlobalFeedProducer,
    });
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledOnce();
    expect(validateKiloGlobalFeedProducer).toHaveBeenCalledOnce();
    expect(facadeFetch).toHaveBeenCalledOnce();
  });

  it('validates producer fencing and forwards accepted producer WebSockets to the user facade', async () => {
    const env = createEnv();
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      validateKiloGlobalFeedProducer,
    });
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
  it.each([
    ['a different audience', 'another-resource'],
    ['the Cloud Agent Next audience string', 'cloud-agent-next'],
    ['an audience array containing Cloud Agent Next', ['another-resource', 'cloud-agent-next']],
    ['a malformed explicit audience', []],
  ])(
    'rejects a raw Kilo JWT with $0 before session access or Durable Object dispatch',
    async (_name, audience) => {
      const env = createEnv();
      const token = signKiloTokenWithAudience(audience, 'usr_feed');

      const response = await fetchWorker(
        new Request('http://worker.test/sessions/usr_feed/agent_live/ingest', {
          headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
        }),
        env
      );

      expect(response.status).toBe(401);
      expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
      expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    }
  );

  it('rejects an audience-less legacy raw Kilo JWT for a different session user before session access', async () => {
    const env = createEnv();
    const token = signKiloToken('usr_feed');

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_other/agent_live/ingest', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Token does not match session user');
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('keeps current session ownership enforcement for an audience-less legacy raw Kilo JWT', async () => {
    const env = createEnv();
    const doFetch = vi.fn();
    const getRuntimeAuthorizationStatus = vi.fn().mockResolvedValue('legacy');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ getRuntimeAuthorizationStatus, fetch: doFetch });
    const token = signKiloToken('usr_feed');
    requireCurrentSessionAccessMock.mockRejectedValue(
      Object.assign(new Error('Session access denied'), { code: 'FORBIDDEN' })
    );

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/agent_live/ingest', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(403);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'usr_feed',
      cloudAgentSessionId: 'agent_live',
    });
    expect(getRuntimeAuthorizationStatus).toHaveBeenCalledOnce();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('accepts a valid wrapper dispatch ticket and forwards to the session Durable Object', async () => {
    const env = createEnv();
    const doFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue('legacy'),
      fetch: doFetch,
    });
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
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue('legacy'),
      fetch: doFetch,
    });
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
  it('rejects a legacy wrapper token before ingest reaches a runtime-authorized session', async () => {
    const env = createEnv();
    const fetch = vi.fn();
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue('active'),
      fetch,
    });

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/agent_live/ingest', {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${signKiloToken('usr_feed')}`,
        },
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
  });

  it('keeps legacy wrapper tokens working for fenced global feed dispatch', async () => {
    const env = createEnv();
    const validateKiloGlobalFeedProducer = vi.fn().mockResolvedValue({ success: true });
    const facadeFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      validateKiloGlobalFeedProducer,
    });
    env.USER_KILO_FACADE.idFromName.mockReturnValue('facade-id');
    env.USER_KILO_FACADE.get.mockReturnValue({ fetch: facadeFetch });

    const response = await fetchWorker(
      new Request(
        'http://worker.test/sessions/usr_feed/agent_live/kilo-global-ingest?kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_1&wrapperGeneration=2&wrapperConnectionId=conn_1',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${signKiloToken('usr_feed')}`,
          },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(validateKiloGlobalFeedProducer).toHaveBeenCalledOnce();
    expect(facadeFetch).toHaveBeenCalledOnce();
  });

  it('rejects a legacy wrapper token before writing a runtime-authorized log archive', async () => {
    const env = Object.assign(createEnv(), { R2_BUCKET: { put: vi.fn() } });
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue('revoked'),
    });

    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/agent_live/logs/session/logs.tar.gz', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${signKiloToken('usr_feed')}` },
        body: 'archive',
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
  });

  it('does not accept legacy raw archives for control-plane sessions', async () => {
    const env = Object.assign(createEnv(), { R2_BUCKET: { put: vi.fn() } });
    const response = await fetchWorker(
      new Request('http://worker.test/sessions/usr_feed/workspace_test/logs/session/logs.tar.gz', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${signKiloToken('usr_feed')}` },
        body: 'raw archive',
      }),
      env
    );
    expect(response.status).toBe(404);
    expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
  });

  function createLogEnv() {
    const env = createEnv();
    return Object.assign(env, {
      R2_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
    });
  }

  it.each([
    ['a different audience', 'another-resource'],
    ['the Cloud Agent Next audience string', 'cloud-agent-next'],
    ['an audience array containing Cloud Agent Next', ['another-resource', 'cloud-agent-next']],
    ['a malformed explicit audience', []],
  ])(
    'rejects a raw Kilo JWT with $0 before session access or R2 upload',
    async (_name, audience) => {
      const env = createLogEnv();
      const token = signKiloTokenWithAudience(audience, 'usr_feed');

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

      expect(response.status).toBe(401);
      expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
      expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
    }
  );

  it('keeps current session ownership enforcement for an audience-less legacy raw Kilo JWT', async () => {
    const env = createLogEnv();
    const token = signKiloToken('usr_feed');
    requireCurrentSessionAccessMock.mockRejectedValue(
      Object.assign(new Error('Session access denied'), { code: 'FORBIDDEN' })
    );

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

    expect(response.status).toBe(403);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'usr_feed',
      cloudAgentSessionId: 'agent_live',
      expectedKiloSessionId: 'ses_12345678901234567890123456',
    });
    expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
  });

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

describe('server /internal/streams/close', () => {
  it('rejects without the internal API key', async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request('http://worker.test/internal/streams/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'usr_removed', organizationId: 'org_1' }),
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(getPgDbMock).not.toHaveBeenCalled();
  });

  it('rejects with an incorrect internal API key', async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request('http://worker.test/internal/streams/close', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'wrong-key',
        },
        body: JSON.stringify({ userId: 'usr_removed', organizationId: 'org_1' }),
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(getPgDbMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request('http://worker.test/internal/streams/close', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({ userId: 'usr_removed' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(getPgDbMock).not.toHaveBeenCalled();
  });

  it('closes org stream sockets for every matching session', async () => {
    const env = createEnv();
    const closeOrgStreams = vi.fn().mockResolvedValue(1);
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ closeOrgStreams });

    getPgDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { cloudAgentSessionId: 'agent_1' },
            { cloudAgentSessionId: 'agent_2' },
          ]),
        })),
      })),
    });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/streams/close', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({ userId: 'usr_removed', organizationId: 'org_1' }),
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('usr_removed:agent_1');
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('usr_removed:agent_2');
    expect(env.CLOUD_AGENT_SESSION.get).toHaveBeenCalledTimes(2);
    expect(closeOrgStreams).toHaveBeenCalledTimes(2);
    expect(closeOrgStreams).toHaveBeenCalledWith('org_1');
  });

  it('closes workspace_ org streams on SANDBOX_SESSION', async () => {
    const env = createEnv();
    const closeOrgStreams = vi.fn().mockResolvedValue(1);
    env.SANDBOX_SESSION.idFromName.mockReturnValue('control-do-id');
    env.SANDBOX_SESSION.get.mockReturnValue({ closeOrgStreams });

    getPgDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
          ]),
        })),
      })),
    });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/streams/close', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({ userId: 'usr_removed', organizationId: 'org_1' }),
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(
      'usr_removed:workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(closeOrgStreams).toHaveBeenCalledWith('org_1');
  });

  it('skips rows without a cloud agent session id', async () => {
    const env = createEnv();
    const closeOrgStreams = vi.fn().mockResolvedValue(0);
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ closeOrgStreams });

    getPgDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ cloudAgentSessionId: null }]),
        })),
      })),
    });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/streams/close', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({ userId: 'usr_removed', organizationId: 'org_1' }),
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(closeOrgStreams).not.toHaveBeenCalled();
  });
});

describe('server /internal/sandbox-control/seed', () => {
  it('rejects without the internal API key', async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request('http://worker.test/internal/sandbox-control/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: 'sbx_test' }),
      }),
      env
    );
    expect(response.status).toBe(401);
    expect(env.SANDBOX_CONTROL.getByName).not.toHaveBeenCalled();
  });

  it('stores the credential hash on the sandbox Durable Object', async () => {
    const env = createEnv();
    const setWrapperCredentialHash = vi.fn().mockResolvedValue(undefined);
    env.SANDBOX_CONTROL.getByName.mockReturnValue({ setWrapperCredentialHash });
    const response = await fetchWorker(
      new Request('http://worker.test/internal/sandbox-control/seed', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({ sandboxId: 'sbx_test' }),
      }),
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sandboxId: string; credential: string };
    expect(body.sandboxId).toBe('sbx_test');
    expect(body.credential).toMatch(/^[0-9a-f]{64}$/);
    expect(env.SANDBOX_CONTROL.getByName).toHaveBeenCalledWith('sbx_test');
    expect(setWrapperCredentialHash).toHaveBeenCalledOnce();
    expect(setWrapperCredentialHash.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('server /sandbox-terminal', () => {
  const sessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('rejects non-WebSocket requests before resolving the session', async () => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request(`http://worker.test/sandbox-terminal/user-1/${sessionId}/pty_123`, {
        headers: { Authorization: 'Bearer producer-capability' },
      }),
      env
    );

    expect(response.status).toBe(426);
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it.each([
    'agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'workspace_invalid',
    'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaax',
  ])('rejects invalid control-plane session identifiers: %s', async invalidSessionId => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request(`http://worker.test/sandbox-terminal/user-1/${invalidSessionId}/pty_123`, {
        headers: { Upgrade: 'websocket', Authorization: 'Bearer producer-capability' },
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid sessionId');
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it.each(['pty.invalid', 'pty/invalid', 'a'.repeat(129)])(
    'rejects invalid wrapper PTY identifiers: %s',
    async ptyId => {
      const env = createEnv();

      const response = await fetchWorker(
        new Request(
          `http://worker.test/sandbox-terminal/user-1/${sessionId}/${encodeURIComponent(ptyId)}`,
          {
            headers: { Upgrade: 'websocket', Authorization: 'Bearer producer-capability' },
          }
        ),
        env
      );

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe('Invalid ptyId');
      expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: 'missing', authorization: undefined },
    { name: 'basic', authorization: 'Basic producer-capability' },
    { name: 'empty bearer', authorization: 'Bearer' },
    { name: 'multiple credentials', authorization: 'Bearer first second' },
    { name: 'oversized bearer', authorization: `Bearer ${'a'.repeat(257)}` },
  ])(
    'rejects $name producer credentials before resolving the session',
    async ({ authorization }) => {
      const env = createEnv();
      const headers = new Headers({ Upgrade: 'websocket' });
      if (authorization !== undefined) headers.set('Authorization', authorization);

      const response = await fetchWorker(
        new Request(`http://worker.test/sandbox-terminal/user-1/${sessionId}/pty_123`, { headers }),
        env
      );

      expect(response.status).toBe(401);
      await expect(response.text()).resolves.toBe('Invalid or missing Authorization header');
      expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    }
  );

  it('routes OAuth owners without double decoding and forwards only wrapper handshake credentials', async () => {
    const ownerId = 'oauth/github:user%2Fteam%25raw%invalid';
    const env = createEnv();
    const sessionResponse = new Response('wrapper bridged', { status: 200 });
    const sessionFetch = vi.fn().mockResolvedValue(sessionResponse);
    env.SANDBOX_SESSION.idFromName.mockReturnValue('sandbox-session-do-id');
    env.SANDBOX_SESSION.get.mockReturnValue({ fetch: sessionFetch });
    const request = new Request(
      `http://worker.test/sandbox-terminal/${encodeURIComponent(ownerId)}/${sessionId}/pty_123?ticket=browser-secret&ptyId=attacker&role=browser`,
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Protocol': 'private-wrapper-protocol',
          'Sec-WebSocket-Extensions': 'permessage-deflate',
          Authorization: 'Bearer producer-capability',
          Cookie: 'session=browser-secret',
          Origin: 'https://attacker.example.com',
          'X-Terminal-Role': 'browser',
          'X-Internal-Role': 'browser',
          'X-Forwarded-User': 'attacker',
        },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response).toBe(sessionResponse);
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(`${ownerId}:${sessionId}`);
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
    expect(sessionFetch).toHaveBeenCalledOnce();

    const forwarded = sessionFetch.mock.calls[0]?.[0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwarded).not.toBe(request);
    expect(forwardedUrl.pathname).toBe('/terminal/wrapper');
    expect(forwardedUrl.search).toBe('?ptyId=pty_123');
    expect(forwarded.headers.get('upgrade')).toBe('websocket');
    expect(forwarded.headers.get('connection')).toBe('Upgrade');
    expect(forwarded.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(forwarded.headers.get('sec-websocket-version')).toBe('13');
    expect(forwarded.headers.get('authorization')).toBe('Bearer producer-capability');
    expect(forwarded.headers.get('sec-websocket-protocol')).toBeNull();
    expect(forwarded.headers.get('sec-websocket-extensions')).toBeNull();
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('origin')).toBeNull();
    expect(forwarded.headers.get('x-terminal-role')).toBeNull();
    expect(forwarded.headers.get('x-internal-role')).toBeNull();
    expect(forwarded.headers.get('x-forwarded-user')).toBeNull();
  });
});

describe('server control log routes', () => {
  it('accepts a log-only grant without touching sandbox liveness', async () => {
    const env = Object.assign(createEnv(), { R2_BUCKET: { put: vi.fn().mockResolvedValue(null) } });
    const identity = {
      sandboxId: 'sandbox_test',
      allocationId: 'allocation_test',
      wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
    };
    const response = await fetchWorker(
      new Request(
        `http://worker.test/sandbox-logs/${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/5886f962-cc33-43f7-bd94-a31c0ed6c13b`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            version: 1,
            sequence: 0,
            droppedRecords: 0,
            records: [
              { timestamp: 100, event: 'wrapper.lifecycle', fields: { phase: 'starting' } },
            ],
          }),
        }
      ),
      env
    );
    expect(response.status).toBe(204);
    expect(env.R2_BUCKET.put).toHaveBeenCalledOnce();
    expect(env.SANDBOX_CONTROL.getByName).not.toHaveBeenCalled();
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
  });

  it('does not expose log archives over HTTP', async () => {
    const env = createEnv();
    for (const path of [
      '/internal/sandbox-logs/sandbox_test',
      '/internal/sandbox-logs/sandbox_test/allocation_test/0fce125c-54a3-4143-b503-b7775c4d2135/5886f962-cc33-43f7-bd94-a31c0ed6c13b',
    ]) {
      const response = await fetchWorker(
        new Request(`http://worker.test${path}`, {
          headers: { 'x-internal-api-key': 'test-internal-secret' },
        }),
        env
      );
      expect(response.status).toBe(404);
    }
    expect(env.SANDBOX_CONTROL.getByName).not.toHaveBeenCalled();
  });
});

describe('server /sandbox-control', () => {
  it('rejects non-websocket requests', async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request('http://worker.test/sandbox-control/sbx_test'),
      env
    );
    expect(response.status).toBe(426);
    expect(env.SANDBOX_CONTROL.getByName).not.toHaveBeenCalled();
  });

  it('rejects an invalid sandboxId before looking up the Durable Object', async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request('http://worker.test/sandbox-control/not%20valid', {
        headers: { Upgrade: 'websocket' },
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(env.SANDBOX_CONTROL.getByName).not.toHaveBeenCalled();
  });

  it('forwards the upgrade to SANDBOX_CONTROL keyed by sandboxId', async () => {
    const env = createEnv();
    const stubResponse = { status: 101 } as Response;
    const fetch = vi.fn().mockResolvedValue(stubResponse);
    env.SANDBOX_CONTROL.getByName.mockReturnValue({ fetch });

    const request = new Request('http://worker.test/sandbox-control/sbx_test', {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer secret' },
    });
    const response = await fetchWorker(request, env);

    expect(env.SANDBOX_CONTROL.getByName).toHaveBeenCalledWith('sbx_test');
    expect(fetch).toHaveBeenCalledOnce();
    expect(response).toBe(stubResponse);
  });
});
