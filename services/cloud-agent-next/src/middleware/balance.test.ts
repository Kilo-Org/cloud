import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import type * as BalanceValidationModule from '../balance-validation.js';
import type * as LoggerModule from '../logger.js';

const { requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../balance-validation.js', async importOriginal => ({
  ...(await importOriginal<typeof BalanceValidationModule>()),
  fetchOrgIdForSession: vi.fn(),
  validateBalanceOnly: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

vi.mock('../logger.js', async importOriginal => ({
  ...(await importOriginal<typeof LoggerModule>()),
  logger: {
    withFields: () => ({ info: vi.fn(), warn: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
  projectSessionAccessHttpError: () => new Response('Session access denied', { status: 403 }),
}));

const { balanceMiddleware } = await import('./balance.js');
const { fetchOrgIdForSession, validateBalanceOnly } = await import('../balance-validation.js');
const { createSessionManagementHandlers } =
  await import('../router/handlers/session-management.js');
const { protectedProcedure, router } = await import('../router/auth.js');

const INTERNAL_API_SECRET = 'internal-api-secret';

describe('balanceMiddleware', () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBalanceOnly).mockResolvedValue({ success: true });
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org-current',
    });
  });

  function createApp() {
    const app = new Hono<HonoContext>();
    app.use('/trpc/*', async (c, next) => {
      c.set('userId', 'user-123');
      c.set('authToken', 'token-123');
      await next();
    });
    app.use('/trpc/*', balanceMiddleware);
    app.post('/trpc/:procedure', c =>
      c.json({ ok: true, validatedSessionAccess: c.get('validatedSessionAccess') })
    );
    return app;
  }

  async function postTrpc(procedureName: string, body: unknown) {
    return createApp().fetch(
      new Request(`https://worker.test/trpc/${procedureName}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
      env
    );
  }

  function createTrpcApp() {
    const calls: string[] = [];
    const testRouter = router({
      start: protectedProcedure.mutation(({ ctx }) => {
        calls.push('start');
        return { ok: true, validatedSessionAccess: ctx.validatedSessionAccess };
      }),
      send: protectedProcedure.mutation(({ ctx }) => {
        calls.push('send');
        return { ok: true, validatedSessionAccess: ctx.validatedSessionAccess };
      }),
      deleteSession: protectedProcedure.mutation(() => {
        calls.push('deleteSession');
        return { ok: true };
      }),
      getSandboxStatus: protectedProcedure.query(() => {
        calls.push('getSandboxStatus');
        return { ok: true };
      }),
    });

    const app = new Hono<HonoContext>();
    app.use('/trpc/*', async (c, next) => {
      c.set('userId', 'user-123');
      c.set('authToken', 'token-123');
      await next();
    });
    app.use('/trpc/*', balanceMiddleware);
    app.use(
      '/trpc/*',
      trpcServer({
        router: testRouter,
        createContext: (_opts, c) => ({
          env: c.env,
          userId: c.get('userId'),
          authToken: c.get('authToken'),
          request: c.req.raw,
        }),
      })
    );
    return { app, calls };
  }

  async function postTrpcApp(
    app: Hono<HonoContext>,
    pathAndQuery: string,
    body: unknown,
    options: { headers?: Record<string, string>; requestEnv?: Env } = {}
  ) {
    return app.fetch(
      new Request(`https://worker.test${pathAndQuery}`, {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...options.headers },
      }),
      options.requestEnv ?? env
    );
  }

  it('rejects a public balance bypass header before checking a paid mutation', async () => {
    vi.mocked(validateBalanceOnly).mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits',
    });
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(
      app,
      '/trpc/start',
      {},
      {
        headers: { 'x-skip-balance-check': 'true' },
        requestEnv: { INTERNAL_API_SECRET } as Env,
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Balance bypass is not supported' },
    });
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('honors the skip header for an authenticated internal caller', async () => {
    vi.mocked(validateBalanceOnly).mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits',
    });
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(
      app,
      '/trpc/start',
      {},
      {
        headers: {
          'x-skip-balance-check': 'true',
          'x-internal-api-key': INTERNAL_API_SECRET,
        },
        requestEnv: { INTERNAL_API_SECRET } as Env,
      }
    );

    expect(response.status).toBe(200);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(calls).toEqual(['start']);
  });

  it('rejects the skip header when the internal API key is invalid', async () => {
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(
      app,
      '/trpc/start',
      {},
      {
        headers: {
          'x-skip-balance-check': 'true',
          'x-internal-api-key': 'wrong',
        },
        requestEnv: { INTERNAL_API_SECRET } as Env,
      }
    );

    expect(response.status).toBe(400);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('does not reject the header on procedures that do not require balance', async () => {
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(
      app,
      '/trpc/deleteSession',
      {},
      {
        headers: { 'x-skip-balance-check': 'true' },
        requestEnv: { INTERNAL_API_SECRET } as Env,
      }
    );

    expect(response.status).toBe(200);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(calls).toEqual(['deleteSession']);
  });

  it.each([
    ['an unencoded path', '/trpc/start,send?batch=1'],
    ['a URL-encoded path', '/trpc/start%2Csend?batch=1'],
  ])('checks each input in %s against its own scope', async (_name, path) => {
    vi.mocked(validateBalanceOnly).mockImplementation(async (_token, orgId) =>
      orgId === 'org-funded'
        ? { success: true }
        : { success: false, status: 402, message: 'Insufficient credits' }
    );
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org-unfunded',
    });
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(app, path, {
      0: { options: { kilocodeOrganizationId: 'org-funded' } },
      1: { cloudAgentSessionId: 'agent-existing' },
    });

    expect(response.status).toBe(402);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-funded', env);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-unfunded', env);
    expect(calls).toEqual([]);
  });

  it('does not let a funded personal input authorize an unfunded organization input', async () => {
    vi.mocked(validateBalanceOnly).mockImplementation(async (_token, orgId) =>
      orgId === undefined
        ? { success: true }
        : { success: false, status: 402, message: 'Insufficient credits' }
    );
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(app, '/trpc/start,start?batch=1', {
      0: {},
      1: { options: { kilocodeOrganizationId: 'org-unfunded' } },
    });

    expect(response.status).toBe(402);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', undefined, env);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-unfunded', env);
    expect(calls).toEqual([]);
  });

  it('does not let a funded organization input authorize an unfunded personal input', async () => {
    vi.mocked(validateBalanceOnly).mockImplementation(async (_token, orgId) =>
      orgId === 'org-funded'
        ? { success: true }
        : { success: false, status: 402, message: 'Insufficient credits' }
    );
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(app, '/trpc/start,start?batch=1', {
      0: { options: { kilocodeOrganizationId: 'org-funded' } },
      1: {},
    });

    expect(response.status).toBe(402);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-funded', env);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', undefined, env);
    expect(calls).toEqual([]);
  });

  it('checks only the mutation in a read/mutation batch', async () => {
    const { app } = createTrpcApp();

    await postTrpcApp(app, '/trpc/getSandboxStatus,send?batch=1', {
      0: { cloudAgentSessionId: 'agent-read' },
      1: { cloudAgentSessionId: 'agent-send' },
    });

    expect(validateBalanceOnly).toHaveBeenCalledTimes(1);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-current', env);
  });

  it('uses each session organization in a batch of session mutations', async () => {
    vi.mocked(validateBalanceOnly).mockImplementation(async (_token, orgId) =>
      orgId === 'org-a'
        ? { success: true }
        : { success: false, status: 402, message: 'Insufficient credits' }
    );
    requireCurrentSessionAccessMock.mockImplementation(async ({ cloudAgentSessionId }) => ({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: cloudAgentSessionId === 'agent-a' ? 'org-a' : 'org-b',
    }));
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(app, '/trpc/send,send?batch=1', {
      0: { cloudAgentSessionId: 'agent-a' },
      1: { cloudAgentSessionId: 'agent-b' },
    });

    expect(response.status).toBe(402);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-a', env);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-b', env);
    expect(calls).toEqual([]);
  });

  it.each([
    ['a non-object batch body', ['start']],
    ['a missing input for a paid procedure', { 1: {} }],
    ['a non-object input for a paid procedure', { 0: 'start' }],
    ['invalid JSON', '{'],
  ])('rejects %s without checking balance', async (_name, body) => {
    const { app, calls } = createTrpcApp();

    const response = await postTrpcApp(app, '/trpc/start?batch=1', body);

    expect(response.status).toBe(400);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('does not use a top-level organization for start balance scope', async () => {
    const { app } = createTrpcApp();

    const response = await postTrpcApp(app, '/trpc/start', {
      kilocodeOrganizationId: 'org-top-level',
    });

    expect(response.status).toBe(200);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', undefined, env);
  });

  it('does not apply balance to a read with the header present', async () => {
    const { app, calls } = createTrpcApp();
    const input = encodeURIComponent(JSON.stringify({ cloudAgentSessionId: 'agent-read' }));

    const response = await app.fetch(
      new Request(`https://worker.test/trpc/getSandboxStatus?input=${input}`, {
        headers: { 'x-skip-balance-check': 'true' },
      }),
      { INTERNAL_API_SECRET } as Env
    );

    expect(response.status).toBe(200);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(calls).toEqual(['getSandboxStatus']);
  });

  it('serves the real passive status query without credits or a balance bypass', async () => {
    vi.mocked(validateBalanceOnly).mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits',
    });
    const snapshot = {
      status: 'sleeping',
      provider: 'Cloudflare',
      observedAt: Date.now(),
      detailCode: 'sandbox_stopped',
      inactivityTimeoutMs: 300_000,
      estimatedSleepAt: null,
    };
    const getSandboxStatus = vi.fn().mockResolvedValue(snapshot);
    const legacyLookup = vi.fn();
    const sandboxLookup = vi.fn(() => ({ getSandboxStatus }));
    const statusEnv = {
      SANDBOX_SESSION: { idFromName: (name: string) => name, get: sandboxLookup },
      CLOUD_AGENT_SESSION: { idFromName: legacyLookup, get: legacyLookup },
    } as unknown as Env;
    const app = new Hono<HonoContext>();
    app.use('/trpc/*', async (c, next) => {
      c.set('userId', 'user-123');
      c.set('authToken', 'token-123');
      await next();
    });
    app.use('/trpc/*', balanceMiddleware);
    app.use(
      '/trpc/*',
      trpcServer({
        router: router({ getSandboxStatus: createSessionManagementHandlers().getSandboxStatus }),
        createContext: (_opts, c) => ({
          env: c.env,
          userId: c.get('userId'),
          authToken: c.get('authToken'),
          request: c.req.raw,
        }),
      })
    );
    const input = encodeURIComponent(
      JSON.stringify({
        cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
      })
    );
    const request = () => new Request(`https://worker.test/trpc/getSandboxStatus?input=${input}`);
    const response = await app.fetch(request(), statusEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { data: snapshot } });
    expect(getSandboxStatus).toHaveBeenCalledTimes(1);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledTimes(1);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(legacyLookup).not.toHaveBeenCalled();

    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const denied = await app.fetch(request(), statusEnv);
    expect(denied.status).toBe(403);
    expect(getSandboxStatus).toHaveBeenCalledTimes(1);
    expect(sandboxLookup).toHaveBeenCalledTimes(1);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
  });

  it.each(['start', 'send', 'sendMessageV2', 'initiateFromKilocodeSessionV2'])(
    'still rejects paid %s execution without credits',
    async procedure => {
      vi.mocked(validateBalanceOnly).mockResolvedValue({
        success: false,
        status: 402,
        message: 'Insufficient credits',
      });
      const response = await postTrpc(procedure, {
        cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
      });
      expect(response.status).toBe(402);
      if (procedure !== 'start') expect(requireCurrentSessionAccessMock).toHaveBeenCalledTimes(1);
      expect(validateBalanceOnly).toHaveBeenCalledTimes(1);
    }
  );

  it('still checks execution ownership before the paid send balance', async () => {
    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const response = await postTrpc('send', {
      cloudAgentSessionId: 'workspace_12345678-1234-4234-9234-123456789abc',
    });
    expect(response.status).toBe(403);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
  });

  it('returns non-retryable clientError for insufficient credits', async () => {
    vi.mocked(validateBalanceOnly).mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits',
    });

    const response = await postTrpc('start', {});
    const body: any = await response.json();

    expect(body.error.data.clientError).toEqual({
      code: 'PAYMENT_REQUIRED',
      message: 'Insufficient credits',
      retryable: false,
    });
  });

  it('returns retryable clientError for balance infrastructure failures', async () => {
    vi.mocked(validateBalanceOnly).mockResolvedValue({
      success: false,
      status: 500,
      message: 'Failed to verify balance',
    });

    const response = await postTrpc('start', {});
    const body: any = await response.json();

    expect(body.error.data.clientError).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to verify balance',
      retryable: true,
    });
  });

  it('uses nested start organization context for balance validation', async () => {
    const orgId = '11111111-2222-3333-4444-555555555555';

    const response = await postTrpc('start', {
      prompt: 'Start a cloud agent session',
      options: {
        kilocodeOrganizationId: orgId,
      },
    });

    expect(response.status).toBe(200);
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', orgId, env);
    expect(fetchOrgIdForSession).not.toHaveBeenCalled();
  });

  it('validates caller-supplied organization context against the stored session scope', async () => {
    const response = await postTrpc('send', {
      cloudAgentSessionId: 'agent-existing',
      kilocodeOrganizationId: 'org-requested',
    });

    expect(response.status).toBe(200);
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env,
      kiloUserId: 'user-123',
      cloudAgentSessionId: 'agent-existing',
      expectedOrganizationId: 'org-requested',
    });
    expect(validateBalanceOnly).toHaveBeenCalledWith('token-123', 'org-current', env);
    await expect(response.json()).resolves.toMatchObject({
      validatedSessionAccess: {
        kiloUserId: 'user-123',
        cloudAgentSessionId: 'agent-existing',
        kiloSessionId: 'ses_12345678901234567890123456',
        organizationId: 'org-current',
      },
    });
  });
});
