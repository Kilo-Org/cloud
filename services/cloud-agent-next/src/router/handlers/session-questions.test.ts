/**
 * Focused handler tests for `getPendingInteractions` and the question answer
 * mutations: an owned control-plane session reads and mutates its Durable
 * Object, a legacy session is rejected before any DO resolution, and a caller
 * who does not own the session is refused before either read.
 *
 * The session-access lookup, the session metadata, and the sandbox-session stub
 * are stubbed so the handler's own access gate and DO routing are exercised
 * deterministically.
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionQuestionHandlers } from './session-questions.js';

const { requireCurrentSessionAccessMock, fetchSessionMetadataMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
  fetchSessionMetadataMock: vi.fn(),
}));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('../../session/metadata.js', () => ({
  fetchSessionMetadata: fetchSessionMetadataMock,
}));

const handlers = createSessionQuestionHandlers();
const router = t.router({
  getPendingInteractions: handlers.getPendingInteractions,
  answerQuestion: handlers.answerQuestion,
});

const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';
const LEGACY_SESSION_ID = 'agent_12345678-1234-1234-1234-123456789abc';

function setup() {
  const stub = {
    getPendingInteractions: vi.fn().mockResolvedValue({ questions: [], permissions: [] }),
    answer: vi.fn().mockResolvedValue('sent'),
  };
  const sandboxSessions = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => stub),
  };
  const context = {
    userId: 'user_owner',
    authToken: 'test-auth-token',
    request: new Request('https://worker.test/trpc'),
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://handler-test' },
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
      SANDBOX_SESSION: sandboxSessions,
    },
  } as unknown as TRPCContext;
  return { stub, sandboxSessions, caller: router.createCaller(context) };
}

describe('getPendingInteractions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'kilo_root',
      organizationId: null,
    });
  });

  it('returns the pending permission of an owned control-plane session', async () => {
    const permission = { id: 'perm_1', sessionID: 'ses_root', title: 'Run command' };
    const harness = setup();
    harness.stub.getPendingInteractions.mockResolvedValue({
      questions: [],
      permissions: [permission],
    });

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: SESSION_ID })
    ).resolves.toEqual({ questions: [], permissions: [permission] });

    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env: expect.objectContaining({ SANDBOX_SESSION: harness.sandboxSessions }),
      kiloUserId: 'user_owner',
      cloudAgentSessionId: SESSION_ID,
    });
    expect(harness.sandboxSessions.idFromName).toHaveBeenCalledWith(`user_owner:${SESSION_ID}`);
    expect(harness.stub.getPendingInteractions).toHaveBeenCalledTimes(1);
  });

  it('returns the empty set for an owned session with nothing pending', async () => {
    const harness = setup();

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: SESSION_ID })
    ).resolves.toEqual({ questions: [], permissions: [] });
    expect(harness.stub.getPendingInteractions).toHaveBeenCalledTimes(1);
  });

  it('rejects a legacy session before resolving its DO', async () => {
    const harness = setup();

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(harness.sandboxSessions.idFromName).not.toHaveBeenCalled();
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
  });

  it('refuses a session the caller does not own without reading it', async () => {
    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const harness = setup();

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: SESSION_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
    expect(harness.stub.getPendingInteractions).not.toHaveBeenCalled();
  });
});

describe('answerQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a fresh control-plane stub for each retry of the answer RPC', async () => {
    fetchSessionMetadataMock.mockResolvedValue({ identity: { sessionId: SESSION_ID } });
    const firstAnswer = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('retryable answer failure'), {
        retryable: true,
      })
    );
    const secondAnswer = vi.fn().mockResolvedValue('sent');
    const sandboxSessions = {
      idFromName: vi.fn((name: string) => name),
      // A distinct stub per resolution, so the retry can only succeed through a
      // freshly built stub rather than the failed one.
      get: vi
        .fn()
        .mockReturnValueOnce({ answer: firstAnswer })
        .mockReturnValueOnce({ answer: secondAnswer }),
    };
    const context = {
      userId: 'user_owner',
      authToken: 'test-auth-token',
      request: new Request('https://worker.test/trpc'),
      env: {
        CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
        SANDBOX_SESSION: sandboxSessions,
      },
    } as unknown as TRPCContext;
    const caller = router.createCaller(context);

    await expect(
      caller.answerQuestion({ sessionId: SESSION_ID, questionId: 'q_1', answers: [['yes']] })
    ).resolves.toEqual({ success: true });

    expect(fetchSessionMetadataMock).toHaveBeenCalledWith(
      expect.objectContaining({ SANDBOX_SESSION: sandboxSessions }),
      'user_owner',
      SESSION_ID
    );
    expect(sandboxSessions.get).toHaveBeenCalledTimes(2);
    expect(firstAnswer).toHaveBeenCalledTimes(1);
    expect(secondAnswer).toHaveBeenCalledTimes(1);
  });

  it('reports a refused settled answer as the payer balance error', async () => {
    fetchSessionMetadataMock.mockResolvedValue({ identity: { sessionId: SESSION_ID } });
    const answer = vi.fn().mockResolvedValue({
      result: 'continuation',
      intent: {
        messageId: 'msg_answer_1',
        turn: { type: 'prompt', prompt: 'yes' },
        agent: { mode: 'code', model: 'test/model' },
      },
    });
    const sandboxSessions = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ answer })),
    };
    const context = {
      userId: 'user_owner',
      authToken: 'test-auth-token',
      request: new Request('https://worker.test/trpc'),
      env: {
        CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
        SANDBOX_SESSION: sandboxSessions,
      },
    } as unknown as TRPCContext;
    const caller = router.createCaller(context);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ balance: 0, isDepleted: true })
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        caller.answerQuestion({ sessionId: SESSION_ID, questionId: 'q_1', answers: [['yes']] })
      ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
      // The balance read used the caller's own bearer.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [balanceInput, balanceInit] = fetchMock.mock.calls[0];
      const balanceUrl = balanceInput instanceof Request ? balanceInput.url : String(balanceInput);
      expect(balanceUrl).toContain('/balance');
      expect(new Headers(balanceInit?.headers).get('Authorization')).toBe('Bearer test-auth-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a capacity refusal before reading the payer balance', async () => {
    fetchSessionMetadataMock.mockResolvedValue({ identity: { sessionId: SESSION_ID } });
    const harness = setup();
    harness.stub.answer.mockResolvedValue({ result: 'queue-full' });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        harness.caller.answerQuestion({
          sessionId: SESSION_ID,
          questionId: 'q_1',
          answers: [['yes']],
        })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        cause: { error: 'PENDING_QUEUE_FULL', retryable: true },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an unreachable payer scope as a missing session', async () => {
    fetchSessionMetadataMock.mockResolvedValue({ identity: { sessionId: SESSION_ID } });
    requireCurrentSessionAccessMock.mockReset();
    requireCurrentSessionAccessMock.mockResolvedValueOnce({
      kiloSessionId: 'kilo_root',
      organizationId: null,
    });
    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const harness = setup();
    harness.stub.answer.mockResolvedValue({
      result: 'continuation',
      intent: {
        messageId: 'msg_answer_1',
        turn: { type: 'prompt', prompt: 'yes' },
        agent: { mode: 'code', model: 'test/model' },
      },
    });

    await expect(
      harness.caller.answerQuestion({
        sessionId: SESSION_ID,
        questionId: 'q_1',
        answers: [['yes']],
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cloud Agent session was not found',
    });
    // The access gate, then the single payer read a denial ends at once.
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledTimes(2);
  });

  it('reports a temporary payer scope read failure as retryable', async () => {
    fetchSessionMetadataMock.mockResolvedValue({ identity: { sessionId: SESSION_ID } });
    requireCurrentSessionAccessMock.mockReset();
    requireCurrentSessionAccessMock.mockResolvedValueOnce({
      kiloSessionId: 'kilo_root',
      organizationId: null,
    });
    requireCurrentSessionAccessMock.mockRejectedValueOnce(new Error('payer read unavailable'));
    requireCurrentSessionAccessMock.mockRejectedValueOnce(new Error('payer read unavailable'));
    const harness = setup();
    harness.stub.answer.mockResolvedValue({
      result: 'continuation',
      intent: {
        messageId: 'msg_answer_1',
        turn: { type: 'prompt', prompt: 'yes' },
        agent: { mode: 'code', model: 'test/model' },
      },
    });

    await expect(
      harness.caller.answerQuestion({
        sessionId: SESSION_ID,
        questionId: 'q_1',
        answers: [['yes']],
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Session access is temporarily unavailable; retry the request',
    });
    // The access gate, then the two payer read attempts.
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a legacy session before reading metadata or resolving its DO', async () => {
    const harness = setup();
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'kilo_root',
      organizationId: null,
    });

    await expect(
      harness.caller.answerQuestion({
        sessionId: LEGACY_SESSION_ID,
        questionId: 'q_1',
        answers: [['yes']],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchSessionMetadataMock).not.toHaveBeenCalled();
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
  });
});
