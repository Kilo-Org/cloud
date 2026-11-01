import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionExecHandlers } from './session-exec.js';

const { requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

const SESSION_ID = 'workspace_12345678-1234-1234-1234-123456789abc';
const execResult = {
  exitCode: 0,
  timedOut: false,
  durationMs: 7,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdout: 'ok\n',
  stderr: '',
};

const handlers = createSessionExecHandlers();
const router = t.router({ execCommand: handlers.execCommand });

function setup() {
  const stub = {
    execCommand: vi.fn().mockResolvedValue({ ok: true, result: execResult }),
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
  return { stub, sandboxSessions, caller: router.createCaller(context) };
}

const input = { cloudAgentSessionId: SESSION_ID, command: 'echo hi' };

describe('execCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'kilo_root',
      organizationId: null,
    });
  });

  it('authorizes the caller before resolving the session DO', async () => {
    requireCurrentSessionAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );
    const harness = setup();

    await expect(harness.caller.execCommand(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith({
      env: expect.objectContaining({ SANDBOX_SESSION: harness.sandboxSessions }),
      kiloUserId: 'user_owner',
      cloudAgentSessionId: SESSION_ID,
    });
    expect(harness.sandboxSessions.get).not.toHaveBeenCalled();
    expect(harness.stub.execCommand).not.toHaveBeenCalled();
  });

  it('defaults timeoutSeconds to 30 and converts it to milliseconds', async () => {
    const harness = setup();

    await expect(harness.caller.execCommand(input)).resolves.toEqual(execResult);
    expect(harness.stub.execCommand).toHaveBeenCalledWith({
      command: 'echo hi',
      timeoutMs: 30_000,
    });
    expect(harness.sandboxSessions.idFromName).toHaveBeenCalledWith(`user_owner:${SESSION_ID}`);
  });

  it('converts an explicit timeoutSeconds', async () => {
    const harness = setup();

    await expect(harness.caller.execCommand({ ...input, timeoutSeconds: 5 })).resolves.toEqual(
      execResult
    );
    expect(harness.stub.execCommand).toHaveBeenCalledWith({
      command: 'echo hi',
      timeoutMs: 5_000,
    });
  });

  it.each([
    [{ ...input, command: '' }],
    [{ ...input, command: 'x'.repeat(10_001) }],
    [{ ...input, timeoutSeconds: 0 }],
    [{ ...input, timeoutSeconds: 61 }],
    [{ ...input, timeoutSeconds: 1.5 }],
    [{ ...input, unknown: true }],
  ])('rejects invalid input %j before the DO', async invalid => {
    const harness = setup();

    await expect(harness.caller.execCommand(invalid as never)).rejects.toBeInstanceOf(TRPCError);
    expect(harness.stub.execCommand).not.toHaveBeenCalled();
  });

  const errorMappings = [
    ['not_found', 'NOT_FOUND', 'Session not found'],
    [
      'not_ready',
      'PRECONDITION_FAILED',
      'The workspace is not ready. Send a message to prepare it, then retry.',
    ],
    [
      'sleeping',
      'PRECONDITION_FAILED',
      'The sandbox is sleeping. Send a message to resume, then retry.',
    ],
    [
      'wrapper_not_connected',
      'PRECONDITION_FAILED',
      'The sandbox runtime is not connected. Send a message to resume, then retry.',
    ],
    [
      'message_running',
      'PRECONDITION_FAILED',
      'A message is running in this session. Wait for it to finish (waitForMessageResult), then retry.',
    ],
    [
      'unsupported',
      'PRECONDITION_FAILED',
      'This sandbox runtime does not support execCommand yet. It will be available after the sandbox restarts on a newer runtime.',
    ],
    [
      'busy',
      'TOO_MANY_REQUESTS',
      'Too many commands are running in this session. Wait for them to finish, then retry.',
    ],
    ['worktree_deleting', 'PRECONDITION_FAILED', 'The worktree is being deleted.'],
    [
      'route_mismatch',
      'PRECONDITION_FAILED',
      'The workspace runtime is not prepared for this session. Send a message to prepare it, then retry.',
    ],
    [
      'execution_unknown',
      'SERVICE_UNAVAILABLE',
      'The command outcome is unknown because the sandbox connection was lost. Inspect the workspace before retrying.',
    ],
    [
      'cancelled',
      'SERVICE_UNAVAILABLE',
      'The command was interrupted after it started. Inspect the workspace before retrying.',
    ],
    ['exec_failed', 'INTERNAL_SERVER_ERROR', 'The command could not be started in the sandbox.'],
  ] as const;

  it.each(errorMappings)('maps %s to %s', async (code, trpcCode, message) => {
    const harness = setup();
    harness.stub.execCommand.mockResolvedValue({
      ok: false,
      error: { code, message: 'internal detail that must not leak', retryable: true },
    });

    await expect(harness.caller.execCommand(input)).rejects.toMatchObject({
      code: trpcCode,
      message,
    });
  });

  it('maps a thrown DO call to execution_unknown without retrying', async () => {
    const harness = setup();
    harness.stub.execCommand.mockRejectedValue(
      Object.assign(new Error('retryable transport failure'), { retryable: true })
    );

    await expect(harness.caller.execCommand(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message:
        'The command outcome is unknown because the sandbox connection was lost. Inspect the workspace before retrying.',
    });
    expect(harness.stub.execCommand).toHaveBeenCalledTimes(1);
    expect(harness.sandboxSessions.get).toHaveBeenCalledTimes(1);
  });
});
