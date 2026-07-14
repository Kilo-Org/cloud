import { classifyVoiceInputPermission, type VoiceInputFeedback } from './voice-input-state';
import { type VoiceInputNative } from './voice-input-controller';

type PermissionResult =
  | { kind: 'granted' }
  | { kind: 'feedback'; feedback: VoiceInputFeedback }
  | { kind: 'client-error' };

export type Lifecycle = { disposed: boolean };

export function isDisposed(lifecycle: Lifecycle): boolean {
  return lifecycle.disposed;
}

const noopBooleanResolver = (_ok: boolean): void => undefined;

export function createTerminal(): {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
} {
  let resolveTerminal: (ok: boolean) => void = noopBooleanResolver;
  const promise = new Promise<boolean>(resolve => {
    resolveTerminal = resolve;
  });
  return { promise, resolve: resolveTerminal };
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
