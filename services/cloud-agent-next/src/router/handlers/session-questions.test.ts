/**
 * Focused handler tests for `getPendingInteractions` (widget approve slice
 * s1): an owned control-plane session returns what its Durable Object waits on,
 * an owned legacy session returns what its wrapper waits on, an idle session
 * returns the empty set, and a caller who does not own the session is refused
 * before either read.
 *
 * The session-access lookup, the session metadata, the agent sandbox, and the
 * sandbox-session stub are stubbed so the handler's own access gate and plane
 * routing are exercised deterministically.
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import { WrapperError } from '../../kilo/wrapper-client.js';
import type { TRPCContext } from '../../types.js';
import { createSessionQuestionHandlers } from './session-questions.js';

const { requireCurrentSessionAccessMock, createAgentSandboxMock, fetchSessionMetadataMock } =
  vi.hoisted(() => ({
    requireCurrentSessionAccessMock: vi.fn(),
    createAgentSandboxMock: vi.fn(),
    fetchSessionMetadataMock: vi.fn(),
  }));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('../../agent-sandbox/factory.js', () => ({
  createAgentSandbox: createAgentSandboxMock,
}));

vi.mock('../../session-service.js', () => ({
  fetchSessionMetadata: fetchSessionMetadataMock,
}));

const handlers = createSessionQuestionHandlers();
const router = t.router({
  getPendingInteractions: handlers.getPendingInteractions,
});

const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';
const LEGACY_SESSION_ID = 'agent_12345678-1234-1234-1234-123456789abc';

type PendingInteractions = { questions: unknown[]; permissions: unknown[] };

/** A wrapper double carrying the one read the legacy plane needs. */
function wrapperDouble(pending: PendingInteractions) {
  return { getPendingInteractions: vi.fn().mockResolvedValue(pending) };
}

/**
 * Resolve the legacy plane down to `wrapper`: the access check passes, the
 * session metadata exists, and the agent sandbox hands back the double (or
 * nothing, for a session whose wrapper is not running).
 */
function setupLegacy(wrapper: ReturnType<typeof wrapperDouble> | null) {
  fetchSessionMetadataMock.mockResolvedValue({ identity: { sessionId: LEGACY_SESSION_ID } });
  createAgentSandboxMock.mockReturnValue({
    getRunningWrapper: async () => wrapper,
  });
}

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

  it("returns a legacy session's pending set from its wrapper", async () => {
    const permission = { id: 'perm_legacy', sessionID: 'ses_root' };
    const harness = setup();
    const wrapper = wrapperDouble({ questions: [], permissions: [permission] });
    setupLegacy(wrapper);

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).resolves.toEqual({ questions: [], permissions: [permission] });

    expect(wrapper.getPendingInteractions).toHaveBeenCalledTimes(1);
    // The legacy plane stores no pending set, so the fresh SANDBOX_SESSION
    // object must never be read for it: it would answer with an empty set
    // where the wrapper holds the session's wait.
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
    expect(harness.stub.getPendingInteractions).not.toHaveBeenCalled();
  });

  it("returns the empty set when a legacy session's wrapper cannot answer", async () => {
    const harness = setup();
    setupLegacy(null);

    // Nothing is readable, so the caller keeps its pre-existing fallback of
    // opening the app rather than being told the read failed.
    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).resolves.toEqual({ questions: [], permissions: [] });
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
  });

  it('returns the empty set when the wrapper predates the read route', async () => {
    const harness = setup();
    setupLegacy({
      getPendingInteractions: vi
        .fn()
        .mockRejectedValue(new WrapperError('Path not found', 'NOT_FOUND', 404)),
    });

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).resolves.toEqual({ questions: [], permissions: [] });
  });

  it('returns the empty set when the running wrapper has no session bound', async () => {
    const harness = setup();
    setupLegacy({
      getPendingInteractions: vi
        .fn()
        .mockRejectedValue(new WrapperError('No session context', 'NO_SESSION', 400)),
    });

    // A wrapper that is running but has no Kilo session bound waits on
    // nothing, so the read reports the empty set instead of failing.
    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).resolves.toEqual({ questions: [], permissions: [] });
  });

  it('fails the read when the wrapper itself errors', async () => {
    const harness = setup();
    setupLegacy({
      getPendingInteractions: vi
        .fn()
        .mockRejectedValue(
          new WrapperError('Failed to read pending interactions', 'KILO_STATE_ERROR', 500)
        ),
    });

    // A wrapper that answers with a failure is not "nothing pending": the
    // caller's retry path must see it instead of a silent empty set.
    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).rejects.toThrow('Failed to read pending interactions');
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

  it('refuses a legacy session the caller does not own without reading its wrapper', async () => {
    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const harness = setup();
    const wrapper = wrapperDouble({ questions: [], permissions: [] });
    setupLegacy(wrapper);

    await expect(
      harness.caller.getPendingInteractions({ cloudAgentSessionId: LEGACY_SESSION_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(wrapper.getPendingInteractions).not.toHaveBeenCalled();
  });
});
