import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import type { Env } from './types.js';
import { mintControlLogUploadGrant } from './sandbox-control/log-upload-grant.js';
import { mintSandboxLaunchCredential } from './sandbox-control/credential.js';
import { previewLabel } from './preview/host.js';
import { PREVIEW_SESSION_MISSING_TEXT } from './preview/container-port-fetch.js';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';

const {
  getRunningTerminalClientMock,
  consumeCloudAgentReportBatchMock,
  removeExpiredCloudAgentReportDataMock,
  runCloudAgentOutcomeCollectionMock,
  runCloudAgentOpenStockCollectionMock,
  requireCurrentSessionAccessMock,
  getPgDbMock,
  loggerWarnMock,
  loggerWithFieldsMock,
} = vi.hoisted(() => ({
  getRunningTerminalClientMock: vi.fn(),
  consumeCloudAgentReportBatchMock: vi.fn().mockResolvedValue(undefined),
  removeExpiredCloudAgentReportDataMock: vi.fn().mockResolvedValue(undefined),
  runCloudAgentOutcomeCollectionMock: vi.fn().mockResolvedValue(undefined),
  runCloudAgentOpenStockCollectionMock: vi.fn().mockResolvedValue(undefined),
  requireCurrentSessionAccessMock: vi.fn(),
  getPgDbMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerWithFieldsMock: vi.fn(),
}));

vi.mock('./logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    withFields: loggerWithFieldsMock,
  };
  loggerWithFieldsMock.mockReturnValue(logger);

  return {
    logger,
    withLogTags: async (_tags: unknown, fn: () => Promise<void>) => fn(),
    WithLogTags: () => (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) =>
      descriptor,
  };
});

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

vi.mock('./byoc/vercel-runtime-identity.js', () => ({
  getVercelRuntimeIdentity: vi.fn().mockResolvedValue({
    wrapperVersion: 'test-wrapper',
    releasedAt: '2026-10-24',
    digest: 'test-runtime-digest',
  }),
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

vi.mock('./telemetry/outcome-aggregate.js', () => ({
  runCloudAgentOutcomeCollection: runCloudAgentOutcomeCollectionMock,
}));

vi.mock('./telemetry/open-stock.js', () => ({
  runCloudAgentOpenStockCollection: runCloudAgentOpenStockCollectionMock,
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

const {
  default: worker,
  REPORT_RETENTION_CRON,
  OUTCOME_AGGREGATE_CRON,
} = await import('./server.js');

const secret = 'test-secret';

type MockEnv = {
  BYOC_VERCEL_IDS?: string;
  VERCEL_SNAPSHOT_BUILD: { getByName: ReturnType<typeof vi.fn> };
  NEXTAUTH_SECRET: string;
  SandboxContainment: unknown;
  SandboxSmallContainment: unknown;
  WS_ALLOWED_ORIGINS?: string;
  HYPERDRIVE: { connectionString: string };
  INTERNAL_API_SECRET?: string;
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
    VERCEL_SNAPSHOT_BUILD: { getByName: vi.fn() },
    SandboxContainment: {},
    SandboxSmallContainment: {},
    HYPERDRIVE: { connectionString: 'postgres://test' },
    INTERNAL_API_SECRET: 'test-internal-secret',
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
      get: vi.fn(() => ({
        isRuntimeAuthorizationRecoveryInProgress: vi.fn().mockResolvedValue(false),
      })),
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
  runCloudAgentOutcomeCollectionMock.mockClear();
  runCloudAgentOpenStockCollectionMock.mockClear();
  loggerWarnMock.mockClear();
  loggerWithFieldsMock.mockClear();
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
        cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      secret,
      { algorithm: 'HS256', expiresIn: -1 }
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/stream?cloudAgentSessionId=workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Ticket expired');
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
  });

  it('rejects a valid ticket when current session access has been removed', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        userId: 'user-1',
        kiloSessionId: 'ses_12345678901234567890123456',
        cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-stream' }
    );
    const env = createEnv();
    requireCurrentSessionAccessMock.mockRejectedValue(
      Object.assign(new Error('Session access denied'), { code: 'FORBIDDEN' })
    );
    const request = new Request(
      `http://worker.test/stream?cloudAgentSessionId=workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&ticket=${encodeURIComponent(ticket)}`,
      { headers: { Upgrade: 'websocket' } }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Session access denied');
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
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

  it('runs only reporting retention cleanup on the daily cron', async () => {
    const env = createEnv();

    await worker.scheduled(
      { cron: REPORT_RETENTION_CRON } as ScheduledController,
      env as unknown as Env
    );

    expect(removeExpiredCloudAgentReportDataMock).toHaveBeenCalledTimes(1);
    expect(removeExpiredCloudAgentReportDataMock).toHaveBeenCalledWith(env);
    expect(runCloudAgentOutcomeCollectionMock).not.toHaveBeenCalled();
    expect(runCloudAgentOpenStockCollectionMock).not.toHaveBeenCalled();
  });

  it('runs the outcome and open-stock collections on the 5-minute cron', async () => {
    const env = createEnv();
    const scheduledTime = Date.parse('2026-02-01T00:10:42.000Z');

    await worker.scheduled(
      { cron: OUTCOME_AGGREGATE_CRON, scheduledTime } as ScheduledController,
      env as unknown as Env
    );

    expect(runCloudAgentOutcomeCollectionMock).toHaveBeenCalledTimes(1);
    expect(runCloudAgentOutcomeCollectionMock).toHaveBeenCalledWith(
      env,
      expect.any(Date),
      scheduledTime
    );
    expect(runCloudAgentOpenStockCollectionMock).toHaveBeenCalledTimes(1);
    expect(runCloudAgentOpenStockCollectionMock).toHaveBeenCalledWith(env);
    expect(removeExpiredCloudAgentReportDataMock).not.toHaveBeenCalled();
  });

  it('runs the collections on the tolerated legacy 3-minute cron', async () => {
    const env = createEnv();
    const scheduledTime = Date.parse('2026-02-01T00:10:42.000Z');

    await worker.scheduled(
      { cron: '*/3 * * * *', scheduledTime } as ScheduledController,
      env as unknown as Env
    );

    expect(runCloudAgentOutcomeCollectionMock).toHaveBeenCalledTimes(1);
    expect(runCloudAgentOutcomeCollectionMock).toHaveBeenCalledWith(
      env,
      expect.any(Date),
      scheduledTime
    );
    expect(runCloudAgentOpenStockCollectionMock).toHaveBeenCalledTimes(1);
    expect(runCloudAgentOpenStockCollectionMock).toHaveBeenCalledWith(env);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('still runs the open-stock collection and preserves the outcome error when outcome collection rejects', async () => {
    const env = createEnv();
    const outcomeError = new Error('outcome collection failed');
    runCloudAgentOutcomeCollectionMock.mockRejectedValueOnce(outcomeError);

    await expect(
      worker.scheduled(
        { cron: OUTCOME_AGGREGATE_CRON } as ScheduledController,
        env as unknown as Env
      )
    ).rejects.toBe(outcomeError);

    expect(runCloudAgentOpenStockCollectionMock).toHaveBeenCalledTimes(1);
    expect(runCloudAgentOpenStockCollectionMock).toHaveBeenCalledWith(env);
  });

  it('runs neither branch for an unrecognized cron and warns', async () => {
    const env = createEnv();

    await worker.scheduled({ cron: '0 0 * * 0' } as ScheduledController, env as unknown as Env);

    expect(removeExpiredCloudAgentReportDataMock).not.toHaveBeenCalled();
    expect(runCloudAgentOutcomeCollectionMock).not.toHaveBeenCalled();
    expect(runCloudAgentOpenStockCollectionMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Cloud Agent scheduled handler received an unrecognized cron',
      { cron: '0 0 * * 0' }
    );
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
    env.SANDBOX_SESSION.get.mockReturnValue({
      fetch: sessionFetch,
      isRuntimeAuthorizationRecoveryInProgress: vi.fn().mockResolvedValue(false),
    });
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

  it('rejects removed session access before Durable Object lookup', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
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
      `http://worker.test/terminal?cloudAgentSessionId=workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      { headers: { Upgrade: 'websocket' } }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
    expect(getRunningTerminalClientMock).not.toHaveBeenCalled();
  });

  it('rejects stream-purpose tickets', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'stream',
        userId: 'user-1',
        cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Invalid ticket purpose');
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('rejects terminal tickets scoped to a different PTY', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        ptyId: 'pty_other',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
    );
    const env = createEnv();
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
      {
        headers: { Upgrade: 'websocket' },
      }
    );

    const response = await fetchWorker(request, env);

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('PTY mismatch');
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });

  it('rejects disallowed WebSocket origins before looking up the session', async () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        ptyId: 'pty_123',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const env = createEnv();
    env.WS_ALLOWED_ORIGINS = 'https://app.example.com';
    const request = new Request(
      `http://worker.test/terminal?cloudAgentSessionId=workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
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
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
  });
  it('rejects agent_ sessions before resolving the control-plane Durable Object', async () => {
    const sessionId = 'agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ticket = signTerminalTicket(sessionId);
    const env = createEnv();
    const consume = installTerminalNonceConsumer(env);

    const response = await fetchWorker(
      new Request(
        `http://worker.test/terminal?cloudAgentSessionId=${sessionId}&ptyId=pty_123&ticket=${encodeURIComponent(ticket)}`,
        { headers: { Upgrade: 'websocket' } }
      ),
      env
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Not found');
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});

describe('server runtime credential proxy public boundary', () => {
  async function handle(
    kiloSessionId = 'kilo_proxy',
    sessionId = 'workspace_proxy'
  ): Promise<string> {
    return issueRuntimeCredentialProxyHandle(
      { NEXTAUTH_SECRET: secret } as never,
      createRuntimeProxyGrant({
        plane: 'legacy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        sessionId,
        kiloSessionId,
        userId: 'usr_proxy',
        orgId: 'org_proxy',
        mode: 'contained',
        allocationId: 'allocation_proxy',
        instanceGeneration: 1,
        leaseExpiresAt: Date.now() + 60_000,
        state: 'active',
      })
    );
  }

  it('rejects a valid handle on the inferred facade with runtime_proxy_origin_required', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test' });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('runtime_proxy_origin_required');
      expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects the inferred facade on a foreign host even with a valid handle', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test' });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request('https://foreign.test/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('runtime_proxy_origin_required');
      expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects the prefixed facade authority with runtime_proxy_origin_required', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test/runtime' });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request('https://worker.test/runtime/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('runtime_proxy_origin_required');
      expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects the explicit compatibility route with a valid bearer', async () => {
    const env = createEnv();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request(
          'https://worker.test/api/runtime-credential-proxy/provider/api/openrouter/models',
          {
            headers: { Authorization: `Bearer ${await handle()}` },
          }
        ),
        env
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('runtime_proxy_origin_required');
      expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects spoofed provider headers on the compatibility route', async () => {
    const env = createEnv();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await fetchWorker(
        new Request('https://worker.test/api/runtime-credential-proxy/ingest/api/session', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await handle()}`,
            'content-type': 'application/json',
            'vercel-sandbox-oidc-token': 'forged-oidc',
            'vercel-forwarded-host': 'worker.test',
            'vercel-forwarded-scheme': 'https',
            'vercel-forwarded-port': '443',
            'vercel-forwarded-path': '/api/session',
          },
          body: '{"sessionId":"kilo_proxy"}',
        }),
        env
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('runtime_proxy_origin_required');
      expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves invalid handles to ordinary routing', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test' });
    const response = await fetchWorker(
      new Request('https://worker.test/api/profile', {
        headers: { Authorization: 'Bearer invalid' },
      }),
      env
    );
    expect(response.status).toBe(404);
    expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
  });

  it('registers the Vercel runtime route before the public facade boundary', async () => {
    const env = Object.assign(createEnv(), { WORKER_URL: 'https://worker.test' });
    const response = await fetchWorker(
      new Request('https://worker.test/runtime-credential-proxy/vercel/ses-abcdef'),
      env
    );
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('runtime_proxy_origin_required');
    expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
  });
});
describe('server /kilo facade route', () => {
  for (const path of ['/kilo', '/kilo/event', '/kilo/cloud-agent/event']) {
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
    env.SANDBOX_SESSION.idFromName.mockReturnValue('do-id');
    env.SANDBOX_SESSION.get.mockReturnValue({ closeOrgStreams });
    const firstSessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const secondSessionId = 'workspace_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    getPgDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { cloudAgentSessionId: firstSessionId },
            { cloudAgentSessionId: secondSessionId },
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
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(`usr_removed:${firstSessionId}`);
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(`usr_removed:${secondSessionId}`);
    expect(env.SANDBOX_SESSION.get).toHaveBeenCalledTimes(2);
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
    expect(closeOrgStreams).toHaveBeenCalledWith('org_1');
  });

  it('skips rows that do not name a control session', async () => {
    const env = createEnv();
    const closeOrgStreams = vi.fn().mockResolvedValue(0);
    env.SANDBOX_SESSION.idFromName.mockReturnValue('do-id');
    env.SANDBOX_SESSION.get.mockReturnValue({ closeOrgStreams });

    getPgDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { cloudAgentSessionId: null },
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
    expect(env.SANDBOX_SESSION.idFromName).not.toHaveBeenCalled();
    expect(closeOrgStreams).not.toHaveBeenCalled();
  });
});

describe('server /internal/widgets/approval-key', () => {
  const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const kiloSessionId = 'ses_0123456789abcdefghijklmnop';
  // sha256(JSON.stringify([kiloSessionId, permissionId])), computed with node:crypto.
  const KEY_PER_WIDGET_1 = '5af2c75e8f72c8f988b4dddda11194e70bc8bab08c4b6abb9f9c6a5f8f34e099';
  const KEY_PER_WIDGET_2 = '841791022542364fd7f7a8c347f13bd075c52134170cb9dc5d6c81e8c7c1a485';

  function approvalKeyRequest(body: unknown, internalKey: string | null = 'test-internal-secret') {
    return new Request('http://worker.test/internal/widgets/approval-key', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(internalKey === null ? {} : { 'x-internal-api-key': internalKey }),
      },
      body: JSON.stringify(body),
    });
  }

  function envWithPending(permissions: unknown[]) {
    const env = createEnv();
    const getPendingInteractions = vi.fn().mockResolvedValue({ questions: [], permissions });
    env.SANDBOX_SESSION.idFromName.mockReturnValue('control-do-id');
    env.SANDBOX_SESSION.get.mockReturnValue({ getPendingInteractions });
    return { env, getPendingInteractions };
  }

  const body = { userId: 'usr_1', organizationId: 'org_1', kiloSessionId, cloudAgentSessionId };

  beforeEach(() => {
    requireCurrentSessionAccessMock.mockReset();
    requireCurrentSessionAccessMock.mockResolvedValue({ kiloSessionId, organizationId: 'org_1' });
  });

  it.each([null, 'wrong-key'])('rejects internal key %s before any session read', async key => {
    const { env, getPendingInteractions } = envWithPending([{ id: 'per_widget_1' }]);
    const response = await fetchWorker(approvalKeyRequest(body, key), env);

    expect(response.status).toBe(401);
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
    expect(getPendingInteractions).not.toHaveBeenCalled();
  });

  it.each([
    { ...body, organizationId: undefined },
    { ...body, kiloSessionId: 'not-a-kilo-session' },
    { ...body, extra: 'mutation-authority' },
  ])('rejects a malformed body', async invalid => {
    const { env, getPendingInteractions } = envWithPending([{ id: 'per_widget_1' }]);
    const response = await fetchWorker(approvalKeyRequest(invalid), env);

    expect(response.status).toBe(400);
    expect(getPendingInteractions).not.toHaveBeenCalled();
  });

  it('binds the oldest pending permission of an owned control-plane session', async () => {
    const { env, getPendingInteractions } = envWithPending([
      { id: '' },
      {
        id: 'per_widget_1',
        permission: 'bash',
        patterns: ['private/path'],
        metadata: { command: 'rm -rf build' },
      },
      { id: 'per_widget_2' },
    ]);
    const response = await fetchWorker(approvalKeyRequest(body), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ approvalKey: KEY_PER_WIDGET_1, command: 'rm -rf build' });
    expect(text).not.toContain('per_widget');
    expect(text).not.toContain('private/path');
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'usr_1',
      cloudAgentSessionId,
      expectedOrganizationId: 'org_1',
      expectedKiloSessionId: kiloSessionId,
    });
    expect(env.SANDBOX_SESSION.idFromName).toHaveBeenCalledWith(`usr_1:${cloudAgentSessionId}`);
    expect(getPendingInteractions).toHaveBeenCalledTimes(1);
  });

  it('produces a different key for a different permission id', async () => {
    const { env } = envWithPending([{ id: 'per_widget_2' }]);
    const response = await fetchWorker(approvalKeyRequest(body), env);

    await expect(response.json()).resolves.toEqual({
      approvalKey: KEY_PER_WIDGET_2,
      command: null,
    });
    expect(KEY_PER_WIDGET_2).not.toBe(KEY_PER_WIDGET_1);
  });

  it('returns a null key and command when nothing is pending', async () => {
    const { env } = envWithPending([]);
    const response = await fetchWorker(approvalKeyRequest(body), env);

    await expect(response.json()).resolves.toEqual({ approvalKey: null, command: null });
  });

  it('returns a null command when the permission carries none', async () => {
    const { env } = envWithPending([{ id: 'per_widget_1', metadata: { command: 42 } }]);
    const response = await fetchWorker(approvalKeyRequest(body), env);

    await expect(response.json()).resolves.toEqual({
      approvalKey: KEY_PER_WIDGET_1,
      command: null,
    });
  });

  it('trims the command to the session card limit', async () => {
    const { env } = envWithPending([
      { id: 'per_widget_1', metadata: { command: `${'a'.repeat(80)}\nsecond line` } },
    ]);
    const response = await fetchWorker(approvalKeyRequest(body), env);

    const parsed = (await response.json()) as { command: string | null };
    expect(parsed.command?.length).toBeLessThanOrEqual(60);
    expect(parsed.command?.endsWith('…')).toBe(true);
  });

  it('refuses a session outside the exact user, organization, and session pairing', async () => {
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const { env, getPendingInteractions } = envWithPending([{ id: 'per_widget_1' }]);
    const response = await fetchWorker(approvalKeyRequest({ ...body, organizationId: null }), env);

    expect(response.status).toBe(403);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOrganizationId: null })
    );
    expect(getPendingInteractions).not.toHaveBeenCalled();
  });

  it('rejects a retired session ID before reading session state', async () => {
    const { env, getPendingInteractions } = envWithPending([{ id: 'per_widget_1' }]);
    const response = await fetchWorker(
      approvalKeyRequest({
        ...body,
        cloudAgentSessionId: 'agent_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
    expect(getPendingInteractions).not.toHaveBeenCalled();
    expect(env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
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
    env.SANDBOX_SESSION.get.mockReturnValue({
      fetch: sessionFetch,
      isRuntimeAuthorizationRecoveryInProgress: vi.fn().mockResolvedValue(false),
    });
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
  it.each([
    undefined,
    '',
    'Basic secret',
    'Bearer',
    'Bearer one two',
    `Bearer ${'x'.repeat(4097)}`,
  ])(
    'rejects missing or malformed authorization before resolving a stub (case %#)',
    async authorization => {
      const env = createEnv();
      const headers = new Headers({ Upgrade: 'websocket' });
      if (authorization !== undefined) headers.set('Authorization', authorization);
      env.SANDBOX_CONTROL.getByName.mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response()),
      });
      const response = await fetchWorker(
        new Request('http://worker.test/sandbox-control/sbx_test', { headers }),
        env
      );
      expect(env.SANDBOX_CONTROL.getByName).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
    }
  );

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
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${mintSandboxLaunchCredential(
          {
            sandboxId: 'sbx_test',
            allocationId: crypto.randomUUID(),
            credential: 'a'.repeat(64),
          },
          secret
        )}`,
      },
    });
    const response = await fetchWorker(request, env);

    expect(env.SANDBOX_CONTROL.getByName).toHaveBeenCalledWith('sbx_test');
    expect(fetch).toHaveBeenCalledOnce();
    expect(response).toBe(stubResponse);
  });
});

describe('server preview host dispatch', () => {
  const PREVIEW_SESSION_ID = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const LABEL = previewLabel(PREVIEW_SESSION_ID, 5173) as string;
  const HOST = `${LABEL}.preview.test`;

  function previewEnv(suffix?: string): MockEnv {
    const env = createEnv();
    if (suffix !== undefined) (env as Record<string, unknown>).PREVIEW_HOST_SUFFIX = suffix;
    return env;
  }

  it('routes a preview hostname away from /health, /trpc and /terminal', async () => {
    const env = previewEnv('preview.test');
    for (const path of ['/health', '/trpc/anything', '/terminal']) {
      const response = await fetchWorker(new Request(`http://${HOST}${path}`), env);
      expect(response.status).toBe(401);
    }
  });

  it('serves a preview-host /terminal WebSocket upgrade from the preview path', async () => {
    const env = previewEnv('preview.test');
    const response = await fetchWorker(
      new Request(`http://${HOST}/terminal`, {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      env
    );
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Cross-origin preview request rejected');
  });

  it('serves a preview-host /stream request from the preview path', async () => {
    const env = previewEnv('preview.test');
    const response = await fetchWorker(
      new Request(`http://${HOST}/stream?cloudAgentSessionId=${PREVIEW_SESSION_ID}`),
      env
    );
    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe(PREVIEW_SESSION_MISSING_TEXT);
  });

  it('serves the preview reserved path from the preview route', async () => {
    const env = previewEnv('preview.test');
    const response = await fetchWorker(new Request(`http://${HOST}/.kilo-preview/other`), env);
    expect(response.status).toBe(404);
  });

  it('keeps the worker host on its own handlers', async () => {
    const env = previewEnv('preview.test');
    const response = await fetchWorker(new Request('http://worker.test/health'), env);
    expect(response.status).toBe(200);
  });

  it('matches nothing when the preview suffix is unset', async () => {
    const env = previewEnv();
    const response = await fetchWorker(new Request(`http://${HOST}/health`), env);
    expect(response.status).toBe(200);
  });

  it('serves the open hop on the worker host and proxies the same path on a preview host', async () => {
    const env = previewEnv('preview.test');
    const workerHost = await fetchWorker(new Request('http://worker.test/preview/open'), env);
    expect(workerHost.status).toBe(401);
    expect(workerHost.headers.get('cache-control')).toBe('no-store');

    const previewHost = await fetchWorker(new Request(`http://${HOST}/preview/open`), env);
    expect(previewHost.status).toBe(401);
    expect(previewHost.headers.get('cache-control')).toBeNull();
  });
});

describe('server /internal/byoc/vercel-enrollment/:organizationId', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';

  it('rejects enrollment requests without the internal API key', async () => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request(`http://worker.test/internal/byoc/vercel-enrollment/${organizationId}`),
      env
    );

    expect(response.status).toBe(401);
  });

  it('rejects invalid organization IDs', async () => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-enrollment/not-an-organization-id', {
        headers: { 'x-internal-api-key': 'test-internal-secret' },
      }),
      env
    );

    expect(response.status).toBe(400);
  });

  it.each([
    { enrolledOrganizations: undefined, enrolled: false },
    { enrolledOrganizations: '22222222-2222-4222-8222-222222222222', enrolled: false },
    { enrolledOrganizations: organizationId, enrolled: true },
    { enrolledOrganizations: '*', enrolled: true },
  ])('returns Worker-configured enrollment for $enrolledOrganizations', async value => {
    const env = createEnv();
    env.BYOC_VERCEL_IDS = value.enrolledOrganizations;

    const response = await fetchWorker(
      new Request(`http://worker.test/internal/byoc/vercel-enrollment/${organizationId}`, {
        headers: { 'x-internal-api-key': 'test-internal-secret' },
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ enrolled: value.enrolled });
  });
});

describe('server /internal/byoc/vercel-snapshot-build/start', () => {
  const buildInput = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    credentialId: '22222222-2222-4222-8222-222222222222',
    buildGeneration: '33333333-3333-4333-8333-333333333333',
  };

  function buildRequest(): Request {
    return new Request('http://worker.test/internal/byoc/vercel-snapshot-build/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': 'test-internal-secret',
      },
      body: JSON.stringify(buildInput),
    });
  }

  it('rejects snapshot builds for organizations outside the Worker enrollment list', async () => {
    const env = createEnv();

    const response = await fetchWorker(buildRequest(), env);

    expect(response.status).toBe(403);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).not.toHaveBeenCalled();
  });

  it('starts snapshot builds for enrolled organizations', async () => {
    const env = createEnv();
    env.BYOC_VERCEL_IDS = buildInput.organizationId;
    const start = vi.fn().mockResolvedValue(undefined);
    env.VERCEL_SNAPSHOT_BUILD.getByName.mockReturnValue({ start });

    const response = await fetchWorker(buildRequest(), env);

    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledWith(buildInput);
  });

  it('starts snapshot builds for an enrolled personal owner without inferring UUID ownership', async () => {
    const env = createEnv();
    const input = {
      userId: 'oauth/vercel-user',
      credentialId: buildInput.credentialId,
      buildGeneration: buildInput.buildGeneration,
    };
    env.BYOC_VERCEL_IDS = input.userId;
    const start = vi.fn().mockResolvedValue(undefined);
    env.VERCEL_SNAPSHOT_BUILD.getByName.mockReturnValue({ start });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(input),
      }),
      env
    );

    expect(response.status).toBe(202);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).toHaveBeenCalledWith('user:oauth/vercel-user');
    expect(start).toHaveBeenCalledWith(input);
  });

  it('rejects snapshot starts that provide both owner identities', async () => {
    const env = createEnv();
    const input = {
      ...buildInput,
      userId: 'oauth/vercel-user',
    };

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(input),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).not.toHaveBeenCalled();
  });
});

describe('server /internal/byoc/vercel-snapshot-build/cleanup', () => {
  const cleanupInput = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    credentialId: '22222222-2222-4222-8222-222222222222',
    buildGeneration: '33333333-3333-4333-8333-333333333333',
    snapshotId: 'snap_persisted',
  };

  it('rejects cleanup requests without the internal API key', async () => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cleanupInput),
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).not.toHaveBeenCalled();
  });

  it('rejects invalid cleanup identity before calling the Durable Object', async () => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/cleanup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify({ ...cleanupInput, credentialId: 'invalid' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).not.toHaveBeenCalled();
  });

  it('passes the persisted runtime snapshot to the organization Durable Object', async () => {
    const env = createEnv();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    env.VERCEL_SNAPSHOT_BUILD.getByName.mockReturnValue({ cleanup });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/cleanup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(cleanupInput),
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).toHaveBeenCalledWith(cleanupInput.organizationId);
    expect(cleanup).toHaveBeenCalledWith(cleanupInput);
  });

  it('passes personal cleanup to the user-keyed Durable Object', async () => {
    const env = createEnv();
    const input = {
      userId: 'oauth/vercel-user',
      credentialId: cleanupInput.credentialId,
      buildGeneration: cleanupInput.buildGeneration,
      snapshotId: cleanupInput.snapshotId,
    };
    const cleanup = vi.fn().mockResolvedValue(undefined);
    env.VERCEL_SNAPSHOT_BUILD.getByName.mockReturnValue({ cleanup });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/cleanup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(input),
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).toHaveBeenCalledWith('user:oauth/vercel-user');
    expect(cleanup).toHaveBeenCalledWith(input);
  });

  it('rejects snapshot cleanup that provides both owner identities', async () => {
    const env = createEnv();
    const input = {
      ...cleanupInput,
      userId: 'oauth/vercel-user',
    };

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/cleanup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(input),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(env.VERCEL_SNAPSHOT_BUILD.getByName).not.toHaveBeenCalled();
  });

  it('returns a safe error when cleanup cannot be completed', async () => {
    const env = createEnv();
    env.VERCEL_SNAPSHOT_BUILD.getByName.mockReturnValue({
      cleanup: vi.fn().mockRejectedValue(new Error('provider request details')),
    });

    const response = await fetchWorker(
      new Request('http://worker.test/internal/byoc/vercel-snapshot-build/cleanup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(cleanupInput),
      }),
      env
    );

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe('Snapshot build resources could not be cleaned up');
  });
});

describe('server /internal/byoc/vercel-enrollment/user/:userId', () => {
  const userId = 'oauth/vercel-user';

  it('returns Worker-configured enrollment for an encoded personal user id', async () => {
    const env = createEnv();
    env.BYOC_VERCEL_IDS = userId;

    const response = await fetchWorker(
      new Request(
        `http://worker.test/internal/byoc/vercel-enrollment/user/${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-api-key': 'test-internal-secret' } }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ enrolled: true });
  });

  it('keeps an empty personal enrollment list disabled', async () => {
    const env = createEnv();

    const response = await fetchWorker(
      new Request(
        `http://worker.test/internal/byoc/vercel-enrollment/user/${encodeURIComponent(userId)}`,
        { headers: { 'x-internal-api-key': 'test-internal-secret' } }
      ),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enrolled: false });
  });
});
