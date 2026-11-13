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

function watchAppState(): void {
  if (watching) {
    return;
  }
  watching = true;
  AppState.addEventListener('change', state => {
    if (state !== 'active') {
      unlocked = false;
    }
  });
}

/**
 * True when this foreground period may use a stored key. `false` covers a
 * refused prompt, a device with no enrolled biometric or passcode, and a
 * native module this build does not carry — all of which mean no key is sent.
 */
export async function requireKeyAccess(promptMessage: string): Promise<boolean> {
  if (unlocked) {
    return true;
  }
  watchAppState();
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
    unlocked = result.success;
    return result.success;
  } catch {
    return false;
  }
}

/** Forgets the current unlock: the next key use asks again. */
export function clearKeyAccess(): void {
  unlocked = false;
}
