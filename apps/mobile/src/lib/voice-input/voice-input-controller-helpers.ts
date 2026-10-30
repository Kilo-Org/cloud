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

/**
 * Wait for a session's terminal outcome, but no longer than `timeoutMs`. A
 * caller that must always finish — releasing a compose lock, starting the next
 * session — cannot depend on the recognizer reporting `end`: only the native
 * binding resolves that promise, and a stalled bridge never does. A timeout
 * tells the caller to abandon the session itself.
 */
export async function waitForTerminalOutcome(
  current: { terminalPromise: Promise<boolean> },
  timeoutMs: number
): Promise<TerminalOutcome> {
  const timeout = Promise.withResolvers<TerminalOutcome>();
  const timer = setTimeout(() => {
    timeout.resolve({ kind: 'timeout' });
  }, timeoutMs);
  const settled = async (): Promise<TerminalOutcome> => {
    try {
      const ok = await current.terminalPromise;
      return { kind: 'settled', ok };
    } catch {
      // terminalPromise never rejects; a rejection is still a settled session.
      return { kind: 'settled', ok: false };
    }
  };
  try {
    return await Promise.race([settled(), timeout.promise]);
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
