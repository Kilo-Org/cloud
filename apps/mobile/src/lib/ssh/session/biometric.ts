import { AppState } from 'react-native';

/**
 * The device-auth gate in front of a stored SSH key.
 *
 * One unlock covers every key in one foreground period: the person proved it
 * is them when they picked up the phone, and asking again per session would
 * train them to dismiss the prompt. Sending the app to the background ends the
 * period, so the next key use asks again.
 */
let unlocked = false;
let watching = false;
let foreground = 0;
let pending: Promise<boolean> | null = null;

function watchAppState(): void {
  if (watching) {
    return;
  }
  watching = true;
  AppState.addEventListener('change', state => {
    if (state === 'background') {
      unlocked = false;
      foreground += 1;
      pending = null;
    }
  });
}

/**
 * True when this foreground period may use a stored key. `false` covers a
 * refused prompt, a device with no enrolled biometric or passcode, and a
 * native module this build does not carry — all of which mean no key is sent.
 */
export async function requireKeyAccess(promptMessage: string): Promise<boolean> {
  watchAppState();
  await waitForForeground();
  if (unlocked) {
    return true;
  }
  if (pending !== null) {
    return pending;
  }
  const period = foreground;
  const request = unlock(promptMessage, period);
  pending = request;
  try {
    return await request;
  } finally {
    if (pending === request) {
      pending = null;
    }
  }
}

export function waitForForeground(): Promise<void> | null {
  if (AppState.currentState === 'active') {
    return null;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active') {
      subscription.remove();
      resolve();
    }
  });
  return promise;
}

async function unlock(promptMessage: string, period: number): Promise<boolean> {
  try {
    // Imported inside the guard: `requireNativeModule` throws at module load
    // when the build carries no such module, so a static import would take
    // every consumer of this file down with it on an older dev client.
    const native = await import('expo-local-authentication');
    const [hardware, enrolled] = await Promise.all([
      native.hasHardwareAsync(),
      native.isEnrolledAsync(),
    ]);
    if (!hardware || !enrolled) {
      return false;
    }
    const result = await native.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
    });
    if (foreground !== period || AppState.currentState === 'background') {
      return false;
    }
    unlocked = result.success;
    return unlocked;
  } catch {
    return false;
  }
}
