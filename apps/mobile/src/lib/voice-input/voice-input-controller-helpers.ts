import { classifyVoiceInputPermission, type VoiceInputFeedback } from './voice-input-state';
import { type VoiceInputNative } from './voice-input-controller';

type PermissionResult =
  | { kind: 'granted' }
  | { kind: 'feedback'; feedback: VoiceInputFeedback }
  | { kind: 'client-error' };

const noopBooleanResolver = (_ok: boolean): void => undefined;

function createBooleanResolver(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} {
  let resolveBoolean = noopBooleanResolver;
  const promise = new Promise<boolean>(resolve => {
    resolveBoolean = resolve;
  });
  return { promise, resolve: resolveBoolean };
}

export type Lifecycle = { disposed: boolean };

export type PendingVoiceInputStart = {
  cancelled: boolean;
  owner: string;
};

export function createVoiceInputStartQueue(): {
  cancel: (owner?: string) => void;
  run: (
    request: PendingVoiceInputStart,
    task: (request: PendingVoiceInputStart) => Promise<boolean>
  ) => Promise<boolean>;
} {
  let pending: PendingVoiceInputStart | null = null;
  let barrier: Promise<boolean> | null = null;

  return {
    cancel: owner => {
      if (pending && (owner === undefined || pending.owner === owner)) {
        pending.cancelled = true;
      }
    },
    run: async (request, task) => {
      if (pending) {
        pending.cancelled = true;
      }
      pending = request;
      const previousBarrier = barrier;
      const completion = createBooleanResolver();
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
  return createBooleanResolver();
}

export async function waitForTerminal(current: {
  terminalPromise: Promise<boolean>;
}): Promise<void> {
  try {
    await current.terminalPromise;
  } catch {
    // terminalPromise never rejects
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
