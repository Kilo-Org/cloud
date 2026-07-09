import { Hono } from 'hono';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';

const { preflightCloudAgentModelBillingMock } = vi.hoisted(() => ({
  preflightCloudAgentModelBillingMock: vi.fn(),
}));

vi.mock('../balance-validation.js', () => ({
  BALANCE_REQUIRED_MUTATIONS: new Set([
    'prepareSession',
    'initiateFromKilocodeSessionV2',
    'sendMessageV2',
    'start',
    'send',
  ]),
  extractProcedureName: (pathname: string) => {
    const match = pathname.match(/^\/trpc\/([^?/]+)/);
    return match ? match[1] : null;
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    withFields: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../model-billing-preflight.js', () => ({
  preflightCloudAgentModelBilling: preflightCloudAgentModelBillingMock,
}));

const { balanceMiddleware } = await import('./balance.js');
const { INSUFFICIENT_CREDITS_MESSAGE } = await import('../cloud-agent-admission.js');

describe('balanceMiddleware', () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: balance-required with sufficient funds → admits.
    preflightCloudAgentModelBillingMock.mockResolvedValue({
      classification: 'balance-required',
      balance: 5,
      isDepleted: false,
      owner: { userId: 'user-123' },
    });
  });

  function createApp(downstream?: () => void) {
    const app = new Hono<HonoContext>();
    app.use('/trpc/*', async (c, next) => {
      c.set('userId', 'user-123');
      c.set('authToken', 'token-123');
      await next();
    });
    app.use('/trpc/*', balanceMiddleware);
    app.post('/trpc/:procedure', c => {
      downstream?.();
      return c.json({ ok: true, validatedSessionAccess: c.get('validatedSessionAccess') });
    });
    return app;
  }

  async function postTrpc(
    procedureName: string,
    body: unknown,
    options?: { headers?: HeadersInit; downstream?: () => void }
  ) {
    return createApp(options?.downstream).fetch(
      new Request(`https://worker.test/trpc/${procedureName}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...options?.headers },
      }),
      env
    );
  }

  it('returns non-retryable clientError for insufficient credits', async () => {
    preflightCloudAgentModelBillingMock.mockResolvedValue({
      classification: 'balance-required',
      balance: 0,
      isDepleted: true,
      owner: { userId: 'user-123' },
    });

    const downstream = vi.fn();
    const response = await postTrpc('start', { agent: { model: 'paid/model' } }, { downstream });
    const body: any = await response.json();

    expect(response.status).toBe(402);
    expect(body.error.data.clientError).toEqual({
      code: 'PAYMENT_REQUIRED',
      message: INSUFFICIENT_CREDITS_MESSAGE,
      retryable: false,
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it('returns retryable clientError when admission is unavailable', async () => {
    preflightCloudAgentModelBillingMock.mockRejectedValue(
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Cloud agent admission could not be verified',
      })
    );

    const downstream = vi.fn();
    const response = await postTrpc('start', { agent: { model: 'paid/model' } }, { downstream });
    const body: any = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.data.clientError).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Cloud agent admission could not be verified',
      retryable: true,
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each(['prepareSession', 'start', 'initiateFromKilocodeSessionV2', 'sendMessageV2', 'send'])(
    'rejects balance-required %s before reaching its handler at zero balance',
    async procedureName => {
      const downstream = vi.fn();
      preflightCloudAgentModelBillingMock.mockResolvedValue({
        classification: 'balance-required',
        balance: 0,
        isDepleted: true,
        owner: { userId: 'user-123' },
      });

      const response = await postTrpc(
        procedureName,
        { cloudAgentSessionId: 'agent-existing' },
        { downstream }
      );

      expect(response.status).toBe(402);
      expect(downstream).not.toHaveBeenCalled();
    }
  );

  it.each(['free', 'byok'] as const)(
    'admits a %s model without gating on balance',
    async classification => {
      preflightCloudAgentModelBillingMock.mockResolvedValue({
        classification,
        balance: null,
        isDepleted: null,
        owner: { userId: 'user-123' },
      });
      const downstream = vi.fn();

      const response = await postTrpc(
        'start',
        { agent: { model: 'available/model' } },
        { downstream }
      );

      expect(response.status).toBe(200);
      expect(downstream).toHaveBeenCalledOnce();
    }
  );

  it('admits a balance-required model with sufficient balance', async () => {
    const downstream = vi.fn();

    const response = await postTrpc('start', { agent: { model: 'paid/model' } }, { downstream });

    expect(response.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it('does not let the removed header bypass paid zero-balance admission', async () => {
    preflightCloudAgentModelBillingMock.mockResolvedValue({
      classification: 'balance-required',
      balance: 0,
      isDepleted: true,
      owner: { userId: 'user-123' },
    });
    const downstream = vi.fn();

    const response = await postTrpc(
      'start',
      { agent: { model: 'paid/model' } },
      { headers: { 'x-skip-balance-check': 'true' }, downstream }
    );

    expect(response.status).toBe(402);
    expect(downstream).not.toHaveBeenCalled();
  });

  it('retains trusted existing-session access for downstream handlers', async () => {
    preflightCloudAgentModelBillingMock.mockResolvedValue({
      classification: 'free',
      balance: null,
      isDepleted: null,
      owner: { organizationId: 'org-current' },
      validatedSessionAccess: {
        kiloUserId: 'user-123',
        cloudAgentSessionId: 'agent-existing',
        kiloSessionId: 'ses_12345678901234567890123456',
        organizationId: 'org-current',
      },
    });

    const response = await postTrpc('send', { cloudAgentSessionId: 'agent-existing' });

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
