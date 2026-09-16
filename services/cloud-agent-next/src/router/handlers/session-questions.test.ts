/**
 * Focused handler tests for `getPendingInteractions` (widget approve slice
 * s1): an owned session returns what it currently waits on, an idle session
 * returns the empty set, and a caller who does not own the session is refused
 * before any Durable Object is read.
 *
 * The session-access lookup and the sandbox-session stub are stubbed so the
 * handler's own access gate and DO routing are exercised deterministically.
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionQuestionHandlers } from './session-questions.js';

const { requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('../../agent-sandbox/factory.js', () => ({
  createAgentSandbox: vi.fn(),
}));

vi.mock('../../session-service.js', () => ({
  fetchSessionMetadata: vi.fn(),
}));

const handlers = createSessionQuestionHandlers();
const router = t.router({
  getPendingInteractions: handlers.getPendingInteractions,
});

const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';

function setup() {
  const stub = {
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

  it('returns the pending permission of an owned session', async () => {
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
