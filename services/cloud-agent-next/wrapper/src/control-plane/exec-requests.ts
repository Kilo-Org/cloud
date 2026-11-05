import {
  EXEC_COMMAND_CAPTURE_BYTES,
  EXEC_COMMAND_OUTPUT_TAIL_BYTES,
  type ControlPlaneExecRequestFrame,
  type ControlPlaneExecResult,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { runDirectoryOperation } from '../control/worktree-operations.js';
import { runProcess, type ExecResult, type ProcessSpawn } from '../utils.js';
import type { PreparedExecRoute } from './prepare.js';

const MAX_CONCURRENT_EXECS_PER_SESSION = 2;
const CANCEL_ALL_DRAIN_TIMEOUT_MS = 3_000;

type ExecAbortReason = 'cancelled' | 'worktree_deleting';

type ActiveExec = {
  controller: AbortController;
  directory: string;
  reason?: ExecAbortReason;
  drained: Promise<void>;
  finish: () => void;
};

export type ControlPlaneExecRequestsDeps = {
  emit: (frame: ControlPlaneWrapperFrame) => void;
  /** The prepared route's execution context, or null while it is not attached. */
  preparedRoute: (sessionId: string) => PreparedExecRoute | null;
  /** Starts the command in the setup workload cgroup when the main wiring supplies it. */
  spawn?: ProcessSpawn;
  runProcess?: typeof runProcess;
};

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function resultOf(captured: ExecResult, redact: (text: string) => string): ControlPlaneExecResult {
  const stdout = redact(captured.stdout);
  const stderr = redact(captured.stderr);
  const stdoutTail = utf8Tail(stdout, EXEC_COMMAND_OUTPUT_TAIL_BYTES);
  const stderrTail = utf8Tail(stderr, EXEC_COMMAND_OUTPUT_TAIL_BYTES);
  return {
    exitCode: captured.exitCode,
    timedOut: captured.terminationReason === 'timeout',
    durationMs: Math.max(0, Math.trunc(captured.elapsedMs ?? 0)),
    stdoutTruncated: captured.stdoutTruncated === true || stdoutTail !== stdout,
    stderrTruncated: captured.stderrTruncated === true || stderrTail !== stderr,
    stdout: stdoutTail,
    stderr: stderrTail,
  };
}

export type ControlPlaneExecRequests = {
  handle(frame: ControlPlaneExecRequestFrame): Promise<void>;
  /** True while a command runs, so the heartbeat can count it as activity. */
  hasActive(): boolean;
  /** Cancels every active command for one session, for route release. */
  cancelSession(sessionId: string): void;
  /** Cancels every active command in one directory, before worktree deletion. */
  cancelDirectory(directory: string): void;
  /** Cancels every active command and resolves when they drain, bounded at 3 s. */
  cancelAll(): Promise<void>;
};

/**
 * Handles the Sandbox DO's bounded non-interactive commands inside the
 * control-plane wrapper. The command runs in the prepared worktree with the
 * route's runtime environment and its current secret redactor. Every request
 * answers with exactly one `exec.result`; command text, output and raw spawn
 * errors never cross an error frame or a log line.
 */
export function createControlPlaneExecRequests(
  deps: ControlPlaneExecRequestsDeps
): ControlPlaneExecRequests {
  const run = deps.runProcess ?? runProcess;
  const active = new Map<string, Set<ActiveExec>>();

  function fail(
    requestId: string,
    code: string,
    message: string,
    retryable: boolean
  ): ControlPlaneWrapperFrame {
    return { type: 'exec.result', requestId, ok: false, error: { code, message, retryable } };
  }

  async function handle(frame: ControlPlaneExecRequestFrame): Promise<void> {
    const { requestId, session, payload } = frame;
    const route = deps.preparedRoute(session.sessionId);
    if (
      route === null ||
      route.kiloSessionId !== session.kiloSessionId ||
      route.directory !== session.directory
    ) {
      deps.emit(
        fail(
          requestId,
          'route_mismatch',
          'The workspace runtime is not prepared for this session.',
          false
        )
      );
      return;
    }
    const sessionActive = active.get(session.sessionId) ?? new Set();
    if (sessionActive.size >= MAX_CONCURRENT_EXECS_PER_SESSION) {
      deps.emit(fail(requestId, 'busy', 'Too many commands are already running', true));
      return;
    }
    const controller = new AbortController();
    const drained = Promise.withResolvers<void>();
    const entry: ActiveExec = {
      controller,
      directory: route.directory,
      drained: drained.promise,
      finish: drained.resolve,
    };
    sessionActive.add(entry);
    active.set(session.sessionId, sessionActive);
    try {
      const captured = await runDirectoryOperation(route.directory, () =>
        run('bash', ['-c', payload.command], {
          cwd: route.directory,
          env: route.env,
          inheritEnv: false,
          timeoutMs: payload.timeoutMs,
          maxOutputBytes: EXEC_COMMAND_CAPTURE_BYTES,
          signal: controller.signal,
          ...(deps.spawn ? { spawn: deps.spawn } : {}),
        })
      );
      if (captured.terminationReason === 'abort') {
        if (entry.reason === 'worktree_deleting') {
          deps.emit(fail(requestId, 'worktree_deleting', 'Worktree is being deleted', true));
        } else {
          deps.emit(
            fail(
              requestId,
              'cancelled',
              'The command was interrupted after it started. Inspect the workspace before retrying.',
              false
            )
          );
        }
        return;
      }
      const redact = deps.preparedRoute(session.sessionId)?.redact ?? route.redact;
      deps.emit({
        type: 'exec.result',
        requestId,
        ok: true,
        result: resultOf(captured, redact),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'worktree_deleting') {
        deps.emit(fail(requestId, 'worktree_deleting', 'Worktree is being deleted', true));
        return;
      }
      deps.emit(fail(requestId, 'exec_failed', 'Command failed to start', true));
    } finally {
      sessionActive.delete(entry);
      if (sessionActive.size === 0) active.delete(session.sessionId);
      entry.finish();
    }
  }

  function abort(entry: ActiveExec, reason: ExecAbortReason): void {
    entry.reason ??= reason;
    entry.controller.abort();
  }

  function cancelSession(sessionId: string): void {
    for (const entry of active.get(sessionId) ?? []) abort(entry, 'cancelled');
  }

  function cancelDirectory(directory: string): void {
    for (const entries of active.values()) {
      for (const entry of entries) {
        if (entry.directory === directory) abort(entry, 'worktree_deleting');
      }
    }
  }

  async function cancelAll(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const entries of active.values()) {
      for (const entry of entries) {
        abort(entry, 'cancelled');
        pending.push(entry.drained);
      }
    }
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, CANCEL_ALL_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    handle,
    hasActive: () => active.size > 0,
    cancelSession,
    cancelDirectory,
    cancelAll,
  };
}
