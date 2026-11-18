import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '../../types.js';

const { requireAccess, getStub, getPage, getDetail } = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  getStub: vi.fn(),
  getPage: vi.fn(),
  getDetail: vi.fn(),
}));
vi.mock('../../session-access.js', () => ({ requireCurrentSessionAccess: requireAccess }));
vi.mock('../../sandbox-session/session-stub.js', () => ({ getSandboxSessionStub: getStub }));
import { router } from '../auth.js';
import { getSessionMessagesPage, getSessionToolPartDetail } from './session-history.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const ROOT = 'ses_12345678901234567890123456';
const CHILD = 'ses_abcdefghijklmnopqrstuvwxyz';
const historyRouter = router({ getSessionMessagesPage, getSessionToolPartDetail });

function caller(overrides: Partial<TRPCContext> = {}) {
  return historyRouter.createCaller({
    userId: 'history-user',
    authToken: 'test-token',
    env: {},
    request: new Request('https://worker.test'),
    ...overrides,
  } as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccess.mockResolvedValue({ kiloSessionId: ROOT, organizationId: null });
  getStub.mockReturnValue({
    getSessionMessagesPage: getPage,
    getSessionToolPartDetail: getDetail,
  });
  getPage.mockResolvedValue({
    kind: 'success',
    info: { id: ROOT },
    messages: [],
    nextCursor: null,
    omittedItemCount: 0,
    updateCursor: 7,
    totalCostMicrodollars: 0,
  });
});

describe('workspace history route', () => {
  it('checks access and pins root identity before reading its DO', async () => {
    expect(await caller().getSessionMessagesPage({ sessionId: SESSION_ID })).toMatchObject({
      updateCursor: 7,
    });
    expect(requireAccess).toHaveBeenCalledWith(
      expect.objectContaining({ kiloUserId: 'history-user', cloudAgentSessionId: SESSION_ID })
    );
    expect(getPage).toHaveBeenCalledWith({
      limit: 50,
      cursor: undefined,
      kiloSessionId: undefined,
      expectedRootKiloSessionId: ROOT,
      toolDisplay: 'full',
    });
  });

  it('forwards child selection without replacing the ledger-authorized root', async () => {
    await caller().getSessionMessagesPage({
      sessionId: SESSION_ID,
      kiloSessionId: CHILD,
      limit: 5,
    });
    expect(getPage).toHaveBeenCalledWith(
      expect.objectContaining({ kiloSessionId: CHILD, expectedRootKiloSessionId: ROOT, limit: 5 })
    );
  });

  it('fails closed before resolving the DO when ledger access is denied', async () => {
    requireAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller().getSessionMessagesPage({ sessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(getStub).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated and legacy session requests', async () => {
    await expect(
      caller({ authToken: '' }).getSessionMessagesPage({ sessionId: SESSION_ID })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller().getSessionMessagesPage({
        sessionId: SESSION_ID.replace('workspace_', 'agent_') as typeof SESSION_ID,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(getStub).not.toHaveBeenCalled();
  });

  it('does not accept caller-supplied server-only root authorization', async () => {
    const input = { sessionId: SESSION_ID, expectedRootKiloSessionId: CHILD } as const;
    await expect(caller().getSessionMessagesPage(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(getStub).not.toHaveBeenCalled();
  });

  it('returns null for missing or unowned selectors without a client fallback', async () => {
    getPage.mockResolvedValue(null);
    expect(await caller().getSessionMessagesPage({ sessionId: SESSION_ID })).toBeNull();
  });

  it('reports malformed cursors as client errors without reading the DO', async () => {
    await expect(
      caller().getSessionMessagesPage({ sessionId: SESSION_ID, cursor: 'not-a-cursor' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(getPage).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'workspace_22222222-2222-4222-8222-222222222222' },
    { rootKiloSessionId: CHILD },
    { kiloSessionId: CHILD },
  ])('rejects mismatched cursor scope before reading the DO: %j', async scope => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        sessionId: SESSION_ID,
        rootKiloSessionId: ROOT,
        kiloSessionId: ROOT,
        createdAt: 1,
        messageId: 'msg_history',
        rowId: 1,
        ...scope,
      })
    ).toString('base64url');
    await expect(
      caller().getSessionMessagesPage({ sessionId: SESSION_ID, cursor })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(getPage).not.toHaveBeenCalled();
  });
});

describe('workspace tool detail route', () => {
  const input = { sessionId: SESSION_ID, messageId: 'msg_1', partId: 'prt_1' } as const;

  it('forwards preview requests to the DO', async () => {
    await caller().getSessionMessagesPage({ sessionId: SESSION_ID, toolDisplay: 'preview' });
    expect(getPage).toHaveBeenCalledWith(expect.objectContaining({ toolDisplay: 'preview' }));
  });

  it('authorizes every read and pins the ledger root', async () => {
    getDetail.mockResolvedValue({
      kind: 'found',
      source: { version: 'v1' },
      revision: 3,
      part: {},
    });
    expect(
      await caller().getSessionToolPartDetail({ ...input, kiloSessionId: CHILD, callId: 'call_1' })
    ).toMatchObject({ kind: 'found', revision: 3 });
    expect(requireAccess).toHaveBeenCalledWith(
      expect.objectContaining({ kiloUserId: 'history-user', cloudAgentSessionId: SESSION_ID })
    );
    expect(getDetail).toHaveBeenCalledWith({
      kiloSessionId: CHILD,
      expectedRootKiloSessionId: ROOT,
      messageId: 'msg_1',
      partId: 'prt_1',
      callId: 'call_1',
    });
  });

  it('fails closed before reading the DO when access is denied', async () => {
    requireAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller().getSessionToolPartDetail(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(getStub).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied root authorization', async () => {
    await expect(
      caller().getSessionToolPartDetail({ ...input, expectedRootKiloSessionId: CHILD } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(getStub).not.toHaveBeenCalled();
  });

  it('reports an unowned selector as not found and DO failures as unavailable', async () => {
    getDetail.mockResolvedValue(null);
    await expect(caller().getSessionToolPartDetail(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    getDetail.mockRejectedValue(new Error('storage reset'));
    await expect(caller().getSessionToolPartDetail(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns stored absence as a typed result rather than empty output', async () => {
    getDetail.mockResolvedValue({ kind: 'not_found' });
    expect(await caller().getSessionToolPartDetail(input)).toEqual({ kind: 'not_found' });
  });
});
