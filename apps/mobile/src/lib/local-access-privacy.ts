import { type NativeModule, requireNativeModule } from 'expo';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { Platform } from 'react-native';

import {
  getLocalAccessSnapshot,
  LocalAccessDeniedError,
  type LocalAccessSnapshot,
  subscribeLocalAccess,
} from '@/lib/local-access';

export type LocalAccessPrivacySnapshot = Readonly<{
  generation: number;
  armed: boolean;
  foreground: boolean;
  covered: boolean;
  failed: boolean;
}>;

/** Only non-sensitive, translated gate copy belongs here. The shell owns every action decision. */
export type LocalAccessPrivacyGate = Readonly<{
  title: string;
  message: string;
  actions: readonly Readonly<{ id: string; label: string; enabled: boolean }>[];
}>;

type GateAction = Readonly<{ generation: number; id: string }>;
// Expo 57's NativeModule type alias describes the constructor, not its event-emitting instance.
type PrivacyModule = InstanceType<
  typeof NativeModule<{
    onVisibilityChange: (snapshot: LocalAccessPrivacySnapshot) => void;
    onGateAction: (action: GateAction) => void;
  }>
> & {
  arm: () => void;
  disarm: () => void;
  cover: () => void;
  getSnapshot: () => LocalAccessPrivacySnapshot;
  publishVisibility: (generation: number) => boolean;
  isForegroundAllowed: () => boolean;
  setGate: (generation: number, gate: LocalAccessPrivacyGate | null) => boolean;
  announce: (message: string, generation: number, gate: boolean) => Promise<boolean>;
};

// Loading this entry never arms protection. The authenticated shell must opt in before mounting.
function nativePrivacy(): PrivacyModule {
  return requireNativeModule<PrivacyModule>('LocalAccessPrivacy');
}

const CAPTURE_KEY = 'local-access-privacy';
let captureReady = false;
let armAttempt = 0;
let captureQueue: Promise<void> | undefined = undefined;
let stopAccessObservation: (() => void) | undefined = undefined;

function accessReady(access: LocalAccessSnapshot): boolean {
  return Boolean(access.userId && access.contextReady && access.foregroundReady && access.unlocked);
}

function observeAccessRevocation(native: PrivacyModule): void {
  stopAccessObservation?.();
  let previous = getLocalAccessSnapshot();
  stopAccessObservation = subscribeLocalAccess(() => {
    const current = getLocalAccessSnapshot();
    const revoked =
      !accessReady(current) ||
      current.userId !== previous.userId ||
      current.authEpoch !== previous.authEpoch ||
      current.unlockGeneration !== previous.unlockGeneration;
    previous = current;
    if (revoked) {
      // This subscription can revoke visibility only. It never publishes a grant or runs a clock.
      native.cover();
    }
  });
}

const captureKeys = new Set<string>();

async function updateCapture(key: string | null): Promise<void> {
  const previous = captureQueue;
  const next = async () => {
    try {
      if (previous) {
        await previous;
      }
    } catch {
      // A failed attempt remains covered; it must not prevent a later explicit repair attempt.
    }
    if (Platform.OS === 'android') {
      if (key !== null) {
        // Expo retains keys after native rejection. Each arm must confirm protection with a fresh key.
        captureKeys.add(key);
        await preventScreenCaptureAsync(key);
      } else {
        for (const ownedKey of captureKeys) {
          // eslint-disable-next-line no-await-in-loop -- finish every release before the queued rearm
          await allowScreenCaptureAsync(ownedKey);
          captureKeys.delete(ownedKey);
        }
      }
    }
  };
  captureQueue = next();
  await captureQueue;
}

/** Await this before mounting authenticated windows, even when biometric locking is disabled. */
export async function armLocalAccessPrivacy(): Promise<LocalAccessPrivacySnapshot> {
  armAttempt += 1;
  const attempt = armAttempt;
  captureReady = false;
  const native = nativePrivacy();
  native.arm();
  observeAccessRevocation(native);
  await updateCapture(`${CAPTURE_KEY}-${attempt}`);
  if (attempt !== armAttempt) {
    throw new LocalAccessDeniedError('stale');
  }
  captureReady = true;
  return native.getSnapshot();
}

/** Call only after authenticated content has unmounted, never as an unlock operation. */
export async function disarmLocalAccessPrivacy(): Promise<void> {
  armAttempt += 1;
  captureReady = false;
  stopAccessObservation?.();
  stopAccessObservation = undefined;
  nativePrivacy().disarm();
  await updateCapture(null);
}

export function getLocalAccessPrivacySnapshot(): LocalAccessPrivacySnapshot {
  return nativePrivacy().getSnapshot();
}

export function coverLocalAccessPrivacy(): void {
  nativePrivacy().cover();
}

/**
 * Use a native generation captured AFTER the shared service reconciles lifecycle and ownership.
 * Native foreground events alone never authorize publication or start authentication.
 * Arming observes access revocation synchronously; only this explicit handshake can uncover.
 */
export function publishLocalAccessVisibility(generation: number): boolean {
  if (!captureReady || !accessReady(getLocalAccessSnapshot())) {
    return false;
  }
  return nativePrivacy().publishVisibility(generation);
}

/** This synchronous native assertion must accompany the shared service's immutable action lease. */
export function assertNativeForeground(): void {
  try {
    if (nativePrivacy().isForegroundAllowed()) {
      return;
    }
  } catch {
    // A missing module or native failure cannot authorize an application effect.
  }
  throw new LocalAccessDeniedError('inactive');
}

export function subscribeLocalAccessPrivacy(
  listener: (snapshot: LocalAccessPrivacySnapshot) => void
): () => void {
  const subscription = nativePrivacy().addListener('onVisibilityChange', listener);
  return () => {
    subscription.remove();
  };
}

export function setLocalAccessPrivacyGate(
  generation: number,
  gate: LocalAccessPrivacyGate | null
): boolean {
  return nativePrivacy().setGate(generation, gate);
}

export function subscribeLocalAccessPrivacyGateActions(listener: (id: string) => void): () => void {
  const native = nativePrivacy();
  const subscription = native.addListener('onGateAction', action => {
    const current = native.getSnapshot();
    if (current.foreground && current.covered && current.generation === action.generation) {
      listener(action.id);
    }
  });
  return () => {
    subscription.remove();
  };
}

/** Native delivery rechecks the captured generation on the UI thread. Denial is never replayed. */
export async function announceLocalAccessPrivacy(
  message: string,
  kind: 'protected' | 'gate' = 'protected'
): Promise<boolean> {
  try {
    const native = nativePrivacy();
    const snapshot = native.getSnapshot();
    if (kind === 'protected' && snapshot.covered) {
      return false;
    }
    return await native.announce(message, snapshot.generation, kind === 'gate');
  } catch {
    return false;
  }
}
