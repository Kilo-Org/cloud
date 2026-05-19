import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Env } from './types.js';
import { WRAPPER_VERSION } from './shared/wrapper-version.js';

const { getSandboxMock, findWrapperForSessionMock } = vi.hoisted(() => ({
  getSandboxMock: vi.fn(),
  findWrapperForSessionMock: vi.fn(),
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
  };
});

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: getSandboxMock,
}));

vi.mock('./kilo/wrapper-manager.js', () => ({
  findWrapperForSession: findWrapperForSessionMock,
}));

vi.mock('./router.js', () => ({
  appRouter: {},
}));

vi.mock('./callbacks/index.js', () => ({
  createCallbackQueueConsumer: vi.fn(),
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
  };
}

function fetchWorker(request: Request, env: MockEnv): Promise<Response> | Response {
  return worker.fetch(request, env as unknown as Env, {} as ExecutionContext);
}

beforeEach(() => {
  getSandboxMock.mockReset();
  findWrapperForSessionMock.mockReset();
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
      version: 1,
      sessionId: 'session-1',
      userId: 'user-1',
      sandboxId,
      createdOnPlatform: 'cloud-agent-web',
      preparedAt: Date.now(),
      workspacePath: '/workspace/user/repo',
    };
    const terminalResponse = new Response('proxied', { status: 200 });
    const wsConnect = vi.fn().mockResolvedValueOnce(terminalResponse);
    const containerFetch = vi.fn().mockResolvedValueOnce(
      Response.json({
        healthy: true,
        state: 'idle',
        version: WRAPPER_VERSION,
        sessionId: 'session-1',
      })
    );
    const sandbox = { containerFetch, wsConnect };
    getSandboxMock.mockReturnValue(sandbox);
    findWrapperForSessionMock.mockResolvedValue({ port: 59954 });
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
    expect(getSandboxMock).toHaveBeenCalledWith(env.Sandbox, sandboxId, expect.any(Object));
    expect(findWrapperForSessionMock).toHaveBeenCalledWith(sandbox, 'session-1');
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(containerFetch.mock.calls[0]).toEqual([
      'http://container/health',
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      59954,
    ]);
    expect(wsConnect).toHaveBeenCalledTimes(1);
    const connectRequest = wsConnect.mock.calls[0]?.[0];
    expect(connectRequest).toBeInstanceOf(Request);
    expect(new URL((connectRequest as Request).url).pathname).toBe('/pty/pty_123/connect');
    expect(wsConnect.mock.calls[0]?.[1]).toBe(59954);
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
