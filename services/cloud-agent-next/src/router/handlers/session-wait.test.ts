import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionWaitHandlers, type WaitPollingDeps } from './session-wait.js';

const { requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';
const MESSAGE_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

function createClock(): {
  deps: WaitPollingDeps;
  sleeps: number[];
  advance: (ms: number) => void;
} {
  let current = 0;
  const sleeps: number[] = [];
  return {
    deps: {
      now: () => current,
      sleep: vi.fn(async (ms: number) => {
        sleeps.push(ms);
        current += ms;
      }),
      intervalMs: 500,
    },
    sleeps,
    advance: ms => {
      current += ms;
    },
  };
}

function foundResult(status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted') {
  return {
    type: 'found' as const,
    result: {
      cloudAgentSessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      status,
      createdAt: 1,
    },
  };
}

function setup() {
  const stub = {
    getMessageResult: vi.fn().mockResolvedValue(foundResult('completed')),
    getPendingInteractions: vi.fn().mockResolvedValue({ questions: [], permissions: [] }),
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
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
      SANDBOX_SESSION: sandboxSessions,
    },
  } as unknown as TRPCContext;
  return {
    stub,
    sandboxSessions,
    context,
    createCaller: (deps: WaitPollingDeps) =>
      t.router({ ...createSessionWaitHandlers(deps) }).createCaller(context),
  };
}

describe('waitForMessageResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'kilo_root',
      organizationId: null,
    });
  });

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'returns immediately for an already %s message',
    async status => {
      const harness = setup();
      harness.stub.getMessageResult.mockResolvedValue(foundResult(status));
      const clock = createClock();

      const result = await harness
        .createCaller(clock.deps)
        .waitForMessageResult({ cloudAgentSessionId: SESSION_ID, messageId: MESSAGE_ID });

      expect(result).toMatchObject({ result: { status }, timedOut: false });
      expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(1);
      expect(clock.sleeps).toEqual([]);
    }
  );

  it('polls until a queued message reaches a terminal status', async () => {
    const harness = setup();
    harness.stub.getMessageResult
      .mockResolvedValueOnce(foundResult('queued'))
      .mockResolvedValueOnce(foundResult('running'))
      .mockResolvedValueOnce(foundResult('completed'));
    const clock = createClock();

    const result = await harness
      .createCaller(clock.deps)
      .waitForMessageResult({ cloudAgentSessionId: SESSION_ID, messageId: MESSAGE_ID });

    expect(result).toMatchObject({ result: { status: 'completed' }, timedOut: false });
    expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('returns immediately when a question is pending', async () => {
    const question = { id: 'q_1', text: 'Which branch?' };
    const harness = setup();
    harness.stub.getMessageResult.mockResolvedValue(foundResult('running'));
    harness.stub.getPendingInteractions.mockResolvedValue({
      questions: [question],
      permissions: [],
    });
    const clock = createClock();

    const result = await harness
      .createCaller(clock.deps)
      .waitForMessageResult({ cloudAgentSessionId: SESSION_ID, messageId: MESSAGE_ID });

    expect(result).toMatchObject({
      result: { status: 'running' },
      pendingInteractions: { questions: [question], permissions: [] },
      timedOut: false,
    });
    expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('returns immediately when a permission is pending', async () => {
    const permission = { id: 'perm_1', title: 'Run command' };
    const harness = setup();
    harness.stub.getMessageResult.mockResolvedValue(foundResult('running'));
    harness.stub.getPendingInteractions.mockResolvedValue({
      questions: [],
      permissions: [permission],
    });
    const clock = createClock();

    const result = await harness
      .createCaller(clock.deps)
      .waitForMessageResult({ cloudAgentSessionId: SESSION_ID, messageId: MESSAGE_ID });

    expect(result).toMatchObject({
      result: { status: 'running' },
      pendingInteractions: { questions: [], permissions: [permission] },
      timedOut: false,
    });
    expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('returns the latest observation with timedOut when the deadline expires', async () => {
    const harness = setup();
    harness.stub.getMessageResult.mockResolvedValue(foundResult('running'));
    const clock = createClock();

    const result = await harness.createCaller(clock.deps).waitForMessageResult({
      cloudAgentSessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      timeoutSeconds: 1,
    });

    expect(result).toMatchObject({ result: { status: 'running' }, timedOut: true });
    expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('prefers a decisive result observed exactly at the deadline', async () => {
    const harness = setup();
    harness.stub.getMessageResult
      .mockResolvedValueOnce(foundResult('queued'))
      .mockResolvedValueOnce(foundResult('running'))
      .mockResolvedValueOnce(foundResult('completed'));
    const clock = createClock();

    const result = await harness.createCaller(clock.deps).waitForMessageResult({
      cloudAgentSessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      timeoutSeconds: 1,
    });

    expect(result).toMatchObject({ result: { status: 'completed' }, timedOut: false });
    expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('fails immediately when the message is unknown', async () => {
    const harness = setup();
    harness.stub.getMessageResult.mockResolvedValue({ type: 'message-not-found' });
    const clock = createClock();

    await expect(
      harness
        .createCaller(clock.deps)
        .waitForMessageResult({ cloudAgentSessionId: SESSION_ID, messageId: MESSAGE_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Message not found' });
    expect(harness.stub.getMessageResult).toHaveBeenCalledTimes(1);
    expect(harness.stub.getPendingInteractions).not.toHaveBeenCalled();
  });

  it('refuses a session the caller does not own without reading it', async () => {
    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const harness = setup();
    const clock = createClock();

    await expect(
      harness
        .createCaller(clock.deps)
        .waitForMessageResult({ cloudAgentSessionId: SESSION_ID, messageId: MESSAGE_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
    expect(harness.stub.getMessageResult).not.toHaveBeenCalled();
  });
});
