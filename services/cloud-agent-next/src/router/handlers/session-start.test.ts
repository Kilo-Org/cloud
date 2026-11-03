import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { createSessionStartHandlers } from './session-start.js';

const { preflight, startNewSession, createSessionWithLedger } = vi.hoisted(() => ({
  preflight: vi.fn(async request => request),
  startNewSession: vi.fn(),
  createSessionWithLedger: vi.fn(),
}));

vi.mock('./session-creation-preflight.js', () => ({ preflightSessionCreation: preflight }));
vi.mock('../../session/session-registration.js', () => ({
  startNewSession,
  createSessionWithLedger,
}));

const ids = {
  cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  kiloSessionId: 'ses_12345678901234567890123456',
  messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
};
const operationKey = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const input = {
  message: { prompt: 'Start a session' },
  agent: { mode: 'code', model: 'kilo/fake-deterministic' },
  repository: { type: 'github' as const, repo: 'acme/repo' },
};
const context: TRPCContext = {
  env: {} as TRPCContext['env'],
  userId: 'oauth/google:start-owner',
  authToken: 'test-auth-token',
  request: new Request('https://worker.test/trpc/start'),
};
const startRouter = router(createSessionStartHandlers());

describe('unified start handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preflight.mockImplementation(async request => request);
    startNewSession.mockResolvedValue({
      ...ids,
      admission: { messageId: ids.messageId, compatibilityDelivery: 'sent' },
    });
    createSessionWithLedger.mockResolvedValue({ ...ids, replayed: false, delivery: 'queued' });
  });

  it('preserves non-ledger creation and the existing response when no key is supplied', async () => {
    await expect(startRouter.createCaller(context).start(input)).resolves.toEqual({
      ...ids,
      delivery: 'queued',
    });
    expect(startNewSession).toHaveBeenCalledOnce();
    expect(createSessionWithLedger).not.toHaveBeenCalled();
  });

  it.each(['desktop', 'cloud-agent-web', 'slack', undefined])(
    'uses the ledger without changing origin %s when a key is supplied',
    async createdOnPlatform => {
      await expect(
        startRouter.createCaller(context).start({
          ...input,
          operationKey,
          options: { createdOnPlatform },
        })
      ).resolves.toEqual({ ...ids, replayed: false, delivery: 'queued' });
      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({ options: { createdOnPlatform } }),
        context,
        'start'
      );
      expect(createSessionWithLedger).toHaveBeenCalledWith(
        expect.objectContaining({ options: { createdOnPlatform } }),
        expect.objectContaining({ userId: context.userId, authToken: context.authToken }),
        expect.objectContaining({
          operationKey,
          billingOrigin: 'cloud-agent',
          includeInitialMessage: true,
          resolveSavedAllocationBeforeAdmission: true,
        })
      );
      expect(startNewSession).not.toHaveBeenCalled();
    }
  );

  it('returns canonical identities, message and delivery from a settled replay', async () => {
    createSessionWithLedger.mockResolvedValue({ ...ids, replayed: true, delivery: 'sent' });
    await expect(
      startRouter.createCaller(context).start({ ...input, operationKey })
    ).resolves.toEqual({ ...ids, replayed: true, delivery: 'sent' });
  });

  it('propagates changed-intent conflicts without falling back to a new session', async () => {
    createSessionWithLedger.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'session_create_intent_conflict' })
    );
    await expect(
      startRouter.createCaller(context).start({ ...input, operationKey })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'session_create_intent_conflict' });
    expect(startNewSession).not.toHaveBeenCalled();
  });

  it('rechecks access and policy before attempting ledger creation or replay', async () => {
    preflight.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(
      startRouter.createCaller(context).start({ ...input, operationKey })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(createSessionWithLedger).not.toHaveBeenCalled();
    expect(startNewSession).not.toHaveBeenCalled();
  });

  it('rejects invalid keys before preflight or creation', async () => {
    await expect(
      startRouter.createCaller(context).start({ ...input, operationKey: 'invalid' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(preflight).not.toHaveBeenCalled();
    expect(createSessionWithLedger).not.toHaveBeenCalled();
  });

  it('requires authentication even when a valid operation key is supplied', async () => {
    await expect(
      startRouter.createCaller({ ...context, authToken: '' }).start({ ...input, operationKey })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(createSessionWithLedger).not.toHaveBeenCalled();
  });

  it('exposes only the existing start procedure', () => {
    expect(Object.keys(createSessionStartHandlers())).toEqual(['start']);
  });
});
