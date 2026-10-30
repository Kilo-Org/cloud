import { classifyVoiceInputPermission, type VoiceInputFeedback } from './voice-input-state';
import { type VoiceInputNative } from './voice-input-controller';

type PermissionResult =
  | { kind: 'granted' }
  | { kind: 'feedback'; feedback: VoiceInputFeedback }
  | { kind: 'client-error' };

export type Lifecycle = { disposed: boolean };

export type PendingVoiceInputStart = {
  cancelled: boolean;
  owner: string;
};

export function createVoiceInputStartQueue() {
  let pending: PendingVoiceInputStart | null = null;
  let barrier: Promise<boolean> | null = null;

  return {
    cancel: (owner?: string) => {
      if (pending && (owner === undefined || pending.owner === owner)) {
        pending.cancelled = true;
      }
    },
    run: async (
      request: PendingVoiceInputStart,
      task: (request: PendingVoiceInputStart) => Promise<boolean>
    ) => {
      if (pending) {
        pending.cancelled = true;
      }
      pending = request;
      const previousBarrier = barrier;
      const completion = Promise.withResolvers<boolean>();
      barrier = completion.promise;
      try {
        if (previousBarrier) {
          await previousBarrier;
        }
        return await task(request);
      } finally {
        if (pending === request) {
          pending = null;
        }
        completion.resolve(true);
      }
    },
  };
}

export function isPendingStartCancelled(request: PendingVoiceInputStart): boolean {
  return request.cancelled;
}

export function isDisposed(lifecycle: Lifecycle): boolean {
  return lifecycle.disposed;
}

export function createTerminal(): {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
} {
  return Promise.withResolvers<boolean>();
}

/** How a bounded terminal wait ended: the session settled, or the bound expired. */
type TerminalOutcome = { kind: 'settled'; ok: boolean } | { kind: 'timeout' };

/** The session state a terminal wait observes: how it ended, and when it last advanced. */
type TerminalWaitTarget = { progressAt: number; terminalPromise: Promise<boolean> };

/**
 * Wait for a session's terminal outcome, but no longer than `timeoutMs` without
 * progress. A caller that must always finish — releasing a compose lock,
 * starting the next session — cannot depend on the recognizer reporting `end`:
 * only the native binding resolves that promise, and a stalled bridge never
 * does.
 *
 * The bound measures silence, not elapsed time. The gateway engine drains its
 * queued segments one request at a time, so a slow network can legitimately
 * spend minutes transcribing audio the user already recorded; each finished
 * segment moves `progressAt` forward and pushes the deadline out. Only a
 * binding that answers nothing for `timeoutMs` expires the wait, and a timeout
 * tells the caller to abandon the session itself.
 */
export function waitForTerminalOutcome(
  current: TerminalWaitTarget,
  timeoutMs: number
): Promise<TerminalOutcome> {
  const terminal: Promise<TerminalOutcome> = (async () => {
    try {
      const ok = await current.terminalPromise;
      return { kind: 'settled' as const, ok };
    } catch {
      // terminalPromise never rejects; a rejection is still a settled session.
      return { kind: 'settled' as const, ok: false };
    }
  })();
  return waitForSilence(terminal, current, timeoutMs);
}

/** Wait out successive silence windows until the session settles or one expires. */
async function waitForSilence(
  terminal: Promise<TerminalOutcome>,
  current: TerminalWaitTarget,
  timeoutMs: number
): Promise<TerminalOutcome> {
  const outcome = await waitOneSilenceWindow(terminal, current, timeoutMs);
  if (outcome.kind === 'settled' || Date.now() - current.progressAt >= timeoutMs) {
    return outcome;
  }
  // The session advanced while the timer was pending: wait out the new
  // silence window instead of abandoning work that is still progressing.
  return waitForSilence(terminal, current, timeoutMs);
}

/** Race one silence window against the session's terminal outcome. */
async function waitOneSilenceWindow(
  terminal: Promise<TerminalOutcome>,
  current: TerminalWaitTarget,
  timeoutMs: number
): Promise<TerminalOutcome> {
  const expired = Promise.withResolvers<TerminalOutcome>();
  const timer = setTimeout(
    () => {
      expired.resolve({ kind: 'timeout' });
    },
    Math.max(0, current.progressAt + timeoutMs - Date.now())
  );
  try {
    return await Promise.race([terminal, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function getPermissionOnce(
  native: VoiceInputNative
): Promise<PermissionResult | { kind: 'needs-request' }> {
  try {
    const current = await native.getPermissions();
    if (current.granted) {
      return { kind: 'granted' };
    }
    if (!current.canAskAgain) {
      const feedback = classifyVoiceInputPermission(current);
      return feedback ? { kind: 'feedback', feedback } : { kind: 'client-error' };
    }
    return { kind: 'needs-request' };
  } catch {
    return { kind: 'client-error' };
  }
}

async function requestPermissionOnce(native: VoiceInputNative): Promise<PermissionResult> {
  try {
    const requested = await native.requestPermissions();
    if (requested.granted) {
      return { kind: 'granted' };
    }
    const feedback = classifyVoiceInputPermission(requested);
    return feedback ? { kind: 'feedback', feedback } : { kind: 'client-error' };
  } catch {
    return { kind: 'client-error' };
  }
}

export async function acquirePermission(native: VoiceInputNative): Promise<PermissionResult> {
  const first = await getPermissionOnce(native);
  if (first.kind !== 'needs-request') {
    return first;
  }
  const result = await requestPermissionOnce(native);
  return result;
}
