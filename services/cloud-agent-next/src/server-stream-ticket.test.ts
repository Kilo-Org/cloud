import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Env } from './types.js';

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
  CLOUD_AGENT_SESSION: {
    idFromName: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  STREAM_TICKET_NONCE_DO: {
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
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
    STREAM_TICKET_NONCE_DO: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
  };
}

/**
 * Stateful in-memory nonce store that mirrors StreamTicketNonceDO's
 * consume-on-first-use semantics: the first consume returns true, any replay
 * returns false.
 */
function installNonceStore(env: MockEnv): Set<string> {
  const used = new Set<string>();
  env.STREAM_TICKET_NONCE_DO.idFromName.mockImplementation((nonce: string) => nonce);
  env.STREAM_TICKET_NONCE_DO.get.mockImplementation((nonce: string) => ({
    consume: async () => {
      if (used.has(nonce)) return false;
      used.add(nonce);
      return true;
    },
  }));
  return used;
}

function fetchWorker(request: Request, env: MockEnv): Promise<Response> | Response {
  return worker.fetch(request, env as unknown as Env, {} as ExecutionContext);
}

function signStreamTicket(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      type: 'stream_ticket',
      userId: 'user-1',
      cloudAgentSessionId: 'session-1',
      nonce: 'nonce-1',
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-stream' }
  );
}

function streamRequest(ticket: string): Request {
  return new Request(
    `http://worker.test/stream?cloudAgentSessionId=session-1&ticket=${encodeURIComponent(ticket)}`,
    { headers: { Upgrade: 'websocket' } }
  );
}

function signTerminalTicket(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      type: 'stream_ticket',
      purpose: 'terminal',
      userId: 'user-1',
      cloudAgentSessionId: 'session-1',
      ptyId: 'pty-1',
      nonce: 'nonce-1',
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
  );
}

function terminalRequest(ticket: string): Request {
  return new Request(
    `http://worker.test/terminal?cloudAgentSessionId=session-1&ptyId=pty-1&ticket=${encodeURIComponent(ticket)}`,
    { headers: { Upgrade: 'websocket' } }
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

describe('server /stream ticket nonce consume', () => {
  it('accepts the first use of a stream ticket and forwards to the session DO', async () => {
    const env = createEnv();
    installNonceStore(env);
    const doFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ fetch: doFetch });
    const ticket = signStreamTicket();

    const response = await fetchWorker(streamRequest(ticket), env);

    expect(response.status).toBe(200);
    expect(env.STREAM_TICKET_NONCE_DO.idFromName).toHaveBeenCalledWith('nonce-1');
    expect(env.CLOUD_AGENT_SESSION.idFromName).toHaveBeenCalledWith('user-1:session-1');
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it('rejects an immediate replay of the same nonce on the worker path', async () => {
    const env = createEnv();
    installNonceStore(env);
    const doFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ fetch: doFetch });
    const ticket = signStreamTicket();

    const first = await fetchWorker(streamRequest(ticket), env);
    expect(first.status).toBe(200);

    const replay = await fetchWorker(streamRequest(ticket), env);
    expect(replay.status).toBe(401);
    await expect(replay.text()).resolves.toBe('Ticket nonce already used');
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a terminal-audience ticket on /stream', async () => {
    const env = createEnv();
    installNonceStore(env);
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
        nonce: 'nonce-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-terminal' }
    );

    const response = await fetchWorker(streamRequest(ticket), env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Invalid ticket audience');
    expect(env.CLOUD_AGENT_SESSION.idFromName).not.toHaveBeenCalled();
    expect(env.STREAM_TICKET_NONCE_DO.idFromName).not.toHaveBeenCalled();
  });

  it('rejects a stream ticket missing a nonce before forwarding', async () => {
    const env = createEnv();
    installNonceStore(env);
    const doFetch = vi.fn();
    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({ fetch: doFetch });
    const ticket = signStreamTicket({ nonce: undefined });

    const response = await fetchWorker(streamRequest(ticket), env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Missing ticket nonce');
    expect(env.STREAM_TICKET_NONCE_DO.idFromName).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('server /terminal ticket nonce consume', () => {
  it('rejects an immediate replay of the same nonce on the terminal path', async () => {
    const env = createEnv();
    installNonceStore(env);

    const connectTerminal = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    getRunningTerminalClientMock.mockResolvedValue({
      status: 'running',
      client: { connectTerminal },
    });

    env.CLOUD_AGENT_SESSION.idFromName.mockReturnValue('session-do-id');
    env.CLOUD_AGENT_SESSION.get.mockReturnValue({
      getMetadata: vi.fn().mockResolvedValue({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: 'session-1',
          userId: 'user-1',
          createdOnPlatform: 'cloud-agent',
        },
        auth: {},
        lifecycle: { version: 1, timestamp: Date.now(), preparedAt: Date.now() },
        workspace: { workspacePath: '/workspace' },
      }),
    });

    const ticket = signTerminalTicket();

    const first = await fetchWorker(terminalRequest(ticket), env);
    expect(first.status).toBe(200);
    expect(connectTerminal).toHaveBeenCalledOnce();

    const replay = await fetchWorker(terminalRequest(ticket), env);
    expect(replay.status).toBe(401);
    await expect(replay.text()).resolves.toBe('Ticket nonce already used');
    expect(connectTerminal).toHaveBeenCalledTimes(1);
  });
});
