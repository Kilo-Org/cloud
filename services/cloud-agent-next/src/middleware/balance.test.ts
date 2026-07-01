import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';

const { requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../balance-validation.js', () => ({
  BALANCE_REQUIRED_MUTATIONS: new Set([
    'initiateFromKilocodeSessionV2',
    'sendMessageV2',
    'start',
    'send',
  ]),
  extractProcedureName: (pathname: string) => {
    const match = pathname.match(/^\/trpc\/([^?/]+)/);
    return match ? match[1] : null;
  },
  fetchOrgIdForSession: vi.fn(),
  validateBalanceOnly: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    withFields: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
  projectSessionAccessHttpError: () => new Response('Session access denied', { status: 403 }),
}));

const { balanceMiddleware } = await import('./balance.js');
const { fetchOrgIdForSession, validateBalanceOnly } = await import('../balance-validation.js');

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
