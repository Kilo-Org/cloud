import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const { createStreamHandlerMock, createAgentRuntimeMock } = vi.hoisted(() => ({
  createStreamHandlerMock: vi.fn(),
  createAgentRuntimeMock: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: vi.fn(),
  ContainerProxy: class ContainerProxy {},
}));

vi.mock('@cloudflare/containers', () => ({}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../logger.js', () => {
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

vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({
  migrate: vi.fn(),
}));

vi.mock('../../drizzle/migrations', () => ({
  default: { journal: {}, migrations: {} },
}));

vi.mock('../session/queries/index.js', () => ({
  createExecutionQueries: vi.fn(() => ({})),
  createEventQueries: vi.fn(() => ({})),
  createLeaseQueries: vi.fn(() => ({})),
}));

vi.mock('../websocket/stream.js', () => ({
  createStreamHandler: createStreamHandlerMock,
  getConnectedStreamClientCount: vi.fn(() => 0),
}));

vi.mock('../session/agent-runtime.js', () => ({
  createAgentRuntime: createAgentRuntimeMock,
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

const { CloudAgentSession } = await import('./CloudAgentSession.js');

const secret = 'test-secret';

type MockStorage = {
  get: ReturnType<typeof vi.fn>;
  sql: unknown;
  getAlarm: ReturnType<typeof vi.fn>;
  setAlarm: ReturnType<typeof vi.fn>;
};

function createCtx() {
  const storage: MockStorage = {
    get: vi.fn().mockResolvedValue(undefined),
    sql: {},
    getAlarm: vi.fn().mockResolvedValue(null),
    setAlarm: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    id: { name: 'user-1:session-1' },
    storage,
    blockConcurrencyWhile: vi.fn().mockResolvedValue(undefined),
    getWebSockets: vi.fn(),
  };
  return ctx;
}

function createEnv() {
  return {
    NEXTAUTH_SECRET: secret,
    WS_ALLOWED_ORIGINS: '',
  };
}

function signTicket(audience: string, purpose?: 'stream' | 'terminal'): string {
  return jwt.sign(
    {
      type: 'stream_ticket',
      userId: 'user-1',
      cloudAgentSessionId: 'session-1',
      ...(purpose ? { purpose } : {}),
      nonce: 'nonce-1',
    },
    secret,
    { algorithm: 'HS256', expiresIn: 60, audience }
  );
}

function streamRequest(ticket: string): Request {
  return new Request(
    `http://worker.test/stream?cloudAgentSessionId=session-1&ticket=${encodeURIComponent(ticket)}`,
    { headers: { Upgrade: 'websocket' } }
  );
}

beforeEach(() => {
  createStreamHandlerMock.mockReset();
  createAgentRuntimeMock.mockReset();
});

describe('CloudAgentSession /stream ticket audience', () => {
  it('accepts a valid stream-audience ticket without consuming the nonce', async () => {
    const handleStreamRequest = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    createStreamHandlerMock.mockReturnValue({ handleStreamRequest });
    createAgentRuntimeMock.mockReturnValue({ requestSnapshot: vi.fn() });

    const env = {
      ...createEnv(),
      // A nonce DO whose methods throw: the DO path must never touch it.
      STREAM_TICKET_NONCE_DO: {
        idFromName: vi.fn(() => {
          throw new Error('consume must not be called on the DO path');
        }),
        get: vi.fn(() => {
          throw new Error('consume must not be called on the DO path');
        }),
      },
    };

    const doInstance = new CloudAgentSession(createCtx() as never, env as never);
    const response = await doInstance.fetch(streamRequest(signTicket('cloud-agent-stream')));

    expect(response.status).toBe(200);
    expect(handleStreamRequest).toHaveBeenCalledOnce();
  });

  it('rejects a terminal-audience ticket on the DO /stream path', async () => {
    const env = createEnv();
    const doInstance = new CloudAgentSession(createCtx() as never, env as never);

    const response = await doInstance.fetch(
      streamRequest(signTicket('cloud-agent-terminal', 'terminal'))
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Invalid ticket audience');
    expect(createStreamHandlerMock).not.toHaveBeenCalled();
  });
});

function makeStreamSocket() {
  return { close: vi.fn() };
}

function makeMetadata(orgId?: string) {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'session-1',
      userId: 'user-1',
      ...(orgId ? { orgId } : {}),
    },
    auth: {},
    lifecycle: { version: 1, timestamp: 1700000000000 },
  };
}

describe('closeOrgStreams', () => {
  it('closes matching stream sockets and returns the count', async () => {
    const ctx = createCtx();
    const doInstance = new CloudAgentSession(ctx as never, createEnv() as never);

    ctx.storage.get.mockResolvedValue(makeMetadata('org_1'));
    const stream1 = makeStreamSocket();
    const stream2 = makeStreamSocket();
    const terminal1 = makeStreamSocket();
    ctx.getWebSockets.mockImplementation((tag: string) =>
      tag === 'stream' ? [stream1, stream2] : [terminal1]
    );

    const closed = await doInstance.closeOrgStreams('org_1');

    expect(closed).toBe(2);
    expect(ctx.getWebSockets).toHaveBeenCalledWith('stream');
    expect(stream1.close).toHaveBeenCalledWith(1000, 'session access revoked');
    expect(stream2.close).toHaveBeenCalledWith(1000, 'session access revoked');
    expect(terminal1.close).not.toHaveBeenCalled();
  });

  it('closes nothing when identity.orgId is missing', async () => {
    const ctx = createCtx();
    const doInstance = new CloudAgentSession(ctx as never, createEnv() as never);

    ctx.storage.get.mockResolvedValue(makeMetadata());

    const closed = await doInstance.closeOrgStreams('org_1');

    expect(closed).toBe(0);
    expect(ctx.getWebSockets).not.toHaveBeenCalled();
  });

  it('closes nothing when identity.orgId does not match', async () => {
    const ctx = createCtx();
    const doInstance = new CloudAgentSession(ctx as never, createEnv() as never);

    ctx.storage.get.mockResolvedValue(makeMetadata('org_other'));

    const closed = await doInstance.closeOrgStreams('org_1');

    expect(closed).toBe(0);
    expect(ctx.getWebSockets).not.toHaveBeenCalled();
  });
});
