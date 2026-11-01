import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import type {
  ControlPlaneControlResult,
  ControlPlaneExecCommandResult,
  ControlPlaneExecCommandInput,
} from '../../shared/control-plane-protocol.js';
import { SandboxSessionV2 } from './session-do.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';
const DIRECTORY = '/workspace/private/root';

const execResult = {
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdout: 'ok\n',
  stderr: '',
};

type ExecUnit = {
  initialized: Promise<void>;
  sessionId: string;
  registration: unknown;
  route: { state: string };
  messages: Array<{ state: string }>;
  sandboxPeer: () => unknown;
  getSandboxStatus: () => Promise<{ status: string; detailCode: string }>;
  execCommand: (payload: {
    command: string;
    timeoutMs: number;
  }) => Promise<ControlPlaneExecCommandResult>;
};

function unit(overrides: {
  routeState?: 'ready' | 'unknown' | 'failed' | 'reconnecting';
  peer?: unknown;
  sleeping?: boolean;
  registration?: unknown;
}) {
  const session = Object.create(SandboxSessionV2.prototype) as ExecUnit;
  session.initialized = Promise.resolve();
  session.sessionId = SESSION_ID;
  session.registration =
    'registration' in overrides
      ? overrides.registration
      : {
          sandboxId: SANDBOX_ID,
          spec: { kiloSessionId: KILO_SESSION_ID, directory: DIRECTORY },
        };
  session.route = { state: overrides.routeState ?? 'ready' };
  session.messages = [];
  session.sandboxPeer = () => overrides.peer ?? null;
  session.getSandboxStatus = async () =>
    overrides.sleeping === true
      ? { status: 'sleeping', detailCode: 'sandbox_stopped' }
      : { status: 'active', detailCode: 'sandbox_ready' };
  return session;
}

function forwarded(overrides: Partial<ControlPlaneControlResult> = {}) {
  return { ok: true, result: execResult, ...overrides } as ControlPlaneControlResult;
}

describe('SandboxSessionV2.execCommand', () => {
  it('forwards the command with the registered route identity', async () => {
    const execCommand = vi.fn(
      async (_input: ControlPlaneExecCommandInput): Promise<ControlPlaneControlResult> =>
        forwarded()
    );
    const session = unit({ peer: { execCommand } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: true,
      result: execResult,
    });
    expect(execCommand).toHaveBeenCalledWith({
      session: {
        sessionId: SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        directory: DIRECTORY,
      },
      payload: { command: 'echo hi', timeoutMs: 5_000 },
    });
  });

  it('rejects while a message is accepted without contacting the sandbox', async () => {
    const execCommand = vi.fn();
    const session = unit({ peer: { execCommand } });
    session.messages = [{ state: 'accepted' }];

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'message_running',
        message: 'A message is running in this session',
        retryable: true,
      },
    });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each(['queued', 'completed', 'failed', 'cancelled'])(
    'does not block on a %s message',
    async state => {
      const execCommand = vi.fn(async () => forwarded());
      const session = unit({ peer: { execCommand } });
      session.messages = [{ state }];

      await expect(
        session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })
      ).resolves.toMatchObject({ ok: true });
      expect(execCommand).toHaveBeenCalledTimes(1);
    }
  );

  it('returns not_ready for an unprepared route without waking the sandbox', async () => {
    const execCommand = vi.fn();
    const prepare = vi.fn();
    const session = unit({ routeState: 'unknown', peer: { execCommand, prepare } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'The workspace is not ready', retryable: true },
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('reports a reconnecting route as a disconnected runtime without forwarding', async () => {
    const execCommand = vi.fn();
    const session = unit({ routeState: 'reconnecting', peer: { execCommand } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'wrapper_not_connected',
        message: 'The sandbox runtime is not connected',
        retryable: true,
      },
    });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('returns sleeping when the passive sandbox status says it is asleep', async () => {
    const execCommand = vi.fn();
    const prepare = vi.fn();
    const session = unit({
      routeState: 'unknown',
      peer: { execCommand, prepare },
      sleeping: true,
    });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: { code: 'sleeping', message: 'The sandbox is sleeping', retryable: true },
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns not_found without a registration', async () => {
    const execCommand = vi.fn();
    const session = unit({ registration: null, peer: { execCommand } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Session not found', retryable: false },
    });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('distinguishes a disconnected wrapper from an unprepared route', async () => {
    const execCommand = vi.fn(async () => ({
      ok: false,
      error: { code: 'not_ready', message: 'Wrapper is not connected', retryable: true },
    }));
    const session = unit({ peer: { execCommand } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'wrapper_not_connected',
        message: 'The sandbox runtime is not connected',
        retryable: true,
      },
    });
  });

  it('passes a wrapper not_ready through instead of remapping it', async () => {
    const execCommand = vi.fn(async () => ({
      ok: false,
      error: { code: 'not_ready', message: 'Session directory is not attached', retryable: false },
    }));
    const session = unit({ peer: { execCommand } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'not_ready',
        message: 'Session directory is not attached',
        retryable: false,
      },
    });
  });

  it.each(['cancelled', 'route_mismatch'])(
    'passes the %s wrapper code through unchanged',
    async code => {
      const execCommand = vi.fn(async () => ({
        ok: false,
        error: { code, message: 'wrapper detail', retryable: false },
      }));
      const session = unit({ peer: { execCommand } });

      await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
        ok: false,
        error: { code, message: 'wrapper detail', retryable: false },
      });
    }
  );

  it('reports a thrown peer call as a non-retryable unknown outcome', async () => {
    const execCommand = vi.fn(async () => {
      throw new Error('sandbox RPC reset');
    });
    const session = unit({ peer: { execCommand } });

    await expect(session.execCommand({ command: 'echo hi', timeoutMs: 5_000 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'execution_unknown',
        message: 'The command outcome is unknown because the sandbox connection was lost',
        retryable: false,
      },
    });
  });

  it('passes wrapper error codes through and rejects an invalid result', async () => {
    const busy = vi.fn(async () => ({
      ok: false,
      error: { code: 'busy', message: 'Too many commands', retryable: true },
    }));
    await expect(
      unit({ peer: { execCommand: busy } }).execCommand({ command: 'echo hi', timeoutMs: 5_000 })
    ).resolves.toMatchObject({ ok: false, error: { code: 'busy' } });

    const malformed = vi.fn(async () => ({ ok: true, result: { stdout: 'only output' } }));
    await expect(
      unit({ peer: { execCommand: malformed } }).execCommand({
        command: 'echo hi',
        timeoutMs: 5_000,
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'exec_failed' } });
  });

  it('validates the payload before forwarding', async () => {
    const execCommand = vi.fn();
    const session = unit({ peer: { execCommand } });

    await expect(session.execCommand({ command: '', timeoutMs: 5_000 })).rejects.toThrow();
    await expect(session.execCommand({ command: 'x', timeoutMs: 500 })).rejects.toThrow();
    expect(execCommand).not.toHaveBeenCalled();
  });
});
