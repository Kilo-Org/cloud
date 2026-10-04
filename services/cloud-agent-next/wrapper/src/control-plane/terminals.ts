import {
  ControlTerminalRuntimeError,
  createControlTerminalRuntime,
} from '../control/terminal-runtime.js';
import {
  forgetAttachedRoot,
  rememberAttachedRoot,
  rootForSession,
} from '../control/session-directories.js';
import type { WorktreeKiloRuntime } from '../control/worktree-runtime.js';
import type { SessionRequestIdentity } from '../../../src/shared/sandbox-control-protocol.js';
import type {
  ControlPlaneTerminalRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { KiloRuntime, KiloRuntimes } from './kilo-runtime.js';

/** The terminal frames this module answers; the requestId is echoed back. */
export type ControlPlaneTerminalRuntime = {
  /**
   * `runtimeKey` is `runtimeKey(spec)` from the preparation manager: it encodes
   * the route's isolation (session id for per-session, directory otherwise).
   */
  rememberAttachedSession(identity: SessionRequestIdentity, runtimeKey: string): void;
  forgetSession(sessionId: string): Promise<void>;
  /** Detaches every attached session for a directory, for worktree deletion (R2). */
  detachDirectory(directory: string): Promise<void>;
  /**
   * True only while an attached session received browser→PTY input inside the
   * activity window (spec §6). A live-but-idle PTY reports false, so an
   * abandoned terminal does not pin the sandbox awake.
   */
  hasRecentInput(): boolean;
  /** Attached sessions with input inside that same window, for the status line. */
  recentInputCount(): number;
  handle(frame: ControlPlaneTerminalRequestFrame): Promise<ControlPlaneWrapperFrame>;
  shutdown(): void;
};

// Mirrors the legacy bridge's `TERMINAL_ACTIVITY_INTERVAL_MS` (terminal-bridge.ts):
// activity is reported at most once per window, and only while input arrives.
const TERMINAL_INPUT_WINDOW_MS = 30_000;
const terminalSignal = new AbortController().signal;

type AttachedTerminal = {
  identity: SessionRequestIdentity;
  runtimeKey: string;
};

function isolationFor(
  runtimeKey: string,
  identity: SessionRequestIdentity
): 'per-session' | 'directory-shared' {
  return runtimeKey === identity.sessionId ? 'per-session' : 'directory-shared';
}

function adaptRuntime(
  runtime: KiloRuntime,
  identity: SessionRequestIdentity,
  isolation: 'per-session' | 'directory-shared'
): WorktreeKiloRuntime {
  return {
    identity,
    isolation,
    scopeId: identity.kiloSessionId,
    runtimeId: identity.sessionId,
    directory: runtime.directory,
    env: runtime.env,
    kiloClient: runtime.client,
    signal: terminalSignal,
  };
}

function failure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ControlTerminalRuntimeError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'failed',
    message: error instanceof Error ? error.message : 'Terminal operation failed',
    retryable: false,
  };
}

/**
 * V2 control-plane terminal adapter (plan B10). The PTY path is the shared
 * `control/terminal-runtime.ts`; this module maps it onto `createKiloRuntimes`
 * runtimes and the new `terminal.*` request frames, answering each with a
 * `terminal.result`.
 */
export function createControlPlaneTerminals(options: {
  controlUrl: string;
  wrapperId: string;
  runtimes: KiloRuntimes;
}): ControlPlaneTerminalRuntime {
  const attached = new Map<string, AttachedTerminal>();
  const inputAt = new Map<string, number>();
  const runtime = createControlTerminalRuntime({
    controlUrl: options.controlUrl,
    wrapperInstanceId: options.wrapperId,
    getKiloRuntime: identity => {
      const attachedSession = attached.get(identity.sessionId);
      if (!attachedSession) return undefined;
      const kiloRuntime = options.runtimes.get(attachedSession.runtimeKey);
      return kiloRuntime
        ? adaptRuntime(
            kiloRuntime,
            identity,
            isolationFor(attachedSession.runtimeKey, attachedSession.identity)
          )
        : undefined;
    },
    onInput: identity => inputAt.set(identity.sessionId, Date.now()),
  });

  function rememberAttachedSession(identity: SessionRequestIdentity, runtimeKey: string): void {
    const alreadyAttached = rootForSession(identity.kiloSessionId) === identity.kiloSessionId;
    attached.set(identity.sessionId, { identity, runtimeKey });
    // The shared PTY path validates ownership through the attached root, which
    // an older runtime registry would normally seed.
    rememberAttachedRoot(identity.kiloSessionId, identity.directory);
    try {
      runtime.rememberAttachedSession(identity);
    } catch (error) {
      attached.delete(identity.sessionId);
      if (!alreadyAttached) forgetAttachedRoot(identity.kiloSessionId, identity.directory);
      throw error;
    }
  }

  async function forgetSession(sessionId: string): Promise<void> {
    const attachedSession = attached.get(sessionId);
    if (!attachedSession) return;
    attached.delete(sessionId);
    inputAt.delete(sessionId);
    await runtime.detachSession(attachedSession.identity);
    forgetAttachedRoot(attachedSession.identity.kiloSessionId, attachedSession.identity.directory);
  }

  async function detachDirectory(directory: string): Promise<void> {
    for (const [sessionId, session] of attached) {
      if (session.identity.directory !== directory) continue;
      attached.delete(sessionId);
      inputAt.delete(sessionId);
    }
    await runtime.detachDirectory(directory);
  }

  function recentInputCount(): number {
    const now = Date.now();
    let count = 0;
    for (const at of inputAt.values()) {
      if (now - at < TERMINAL_INPUT_WINDOW_MS) count += 1;
    }
    return count;
  }

  function hasRecentInput(): boolean {
    return recentInputCount() > 0;
  }

  async function handle(
    frame: ControlPlaneTerminalRequestFrame
  ): Promise<ControlPlaneWrapperFrame> {
    try {
      switch (frame.type) {
        case 'terminal.create':
          return {
            type: 'terminal.result',
            requestId: frame.requestId,
            ok: true,
            result: await runtime.create(frame.session, frame.payload),
          };
        case 'terminal.resize':
          return {
            type: 'terminal.result',
            requestId: frame.requestId,
            ok: true,
            result: await runtime.resize(frame.session, frame.payload),
          };
        case 'terminal.close':
          return {
            type: 'terminal.result',
            requestId: frame.requestId,
            ok: true,
            result: await runtime.close(frame.session, frame.payload),
          };
        case 'terminal.connect':
          return {
            type: 'terminal.result',
            requestId: frame.requestId,
            ok: true,
            result: await runtime.connect(frame.session, frame.payload),
          };
      }
    } catch (error) {
      return {
        type: 'terminal.result',
        requestId: frame.requestId,
        ok: false,
        error: failure(error),
      };
    }
  }

  return {
    rememberAttachedSession,
    forgetSession,
    detachDirectory,
    hasRecentInput,
    recentInputCount,
    handle,
    shutdown: () => runtime.shutdown(),
  };
}
