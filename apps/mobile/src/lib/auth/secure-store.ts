import * as ExpoSecureStore from 'expo-secure-store';

import { secureStoreOptionsArgs } from '@/lib/auth/secure-store-value';
import {
  reportSecureStoreFailure,
  type SecureStoreOperation,
} from '@/lib/telemetry/secure-store-events';

/**
 * Guarded `expo-secure-store`.
 *
 * A native secure-store call can reject for reasons that have nothing to do
 * with the app's data: the keychain is unavailable because the device is
 * locked (iOS `errSecInteractionNotAllowed` on a `WHEN_UNLOCKED*` item), the
 * keystore is not ready after a reboot, or the OS rewrote the item. Every call
 * through this module reports that failure at warning level with the stable
 * operation fingerprint before the rejection reaches the caller, so one
 * failure produces one Sentry issue named after the operation instead of a raw
 * `FunctionCallException` message that changes per platform and OS version.
 *
 * The key and the stored value are never attached to the report: a stored
 * value can be a credential.
 *
 * Semantics are unchanged — the rejection still propagates, because each
 * caller owns its recoverable state (sign-in's persist error, the retryable
 * session-restore surface, a widget action's `failed`). A call whose failure
 * is the same recoverable outcome as an absent value uses the `*Safe` helpers
 * in `secure-store-value`, which never reject.
 */

type SecureStoreOptions = ExpoSecureStore.SecureStoreOptions;

/** Report one failed operation and rethrow so the caller owns the outcome. */
function reportAndRethrow(operation: SecureStoreOperation, error: unknown): never {
  reportSecureStoreFailure(operation, error);
  throw error;
}

export async function getItemAsync(
  key: string,
  options?: SecureStoreOptions
): Promise<string | null> {
  try {
    return await ExpoSecureStore.getItemAsync(key, ...secureStoreOptionsArgs(options));
  } catch (error) {
    return reportAndRethrow('read', error);
  }
}

export async function setItemAsync(
  key: string,
  value: string,
  options?: SecureStoreOptions
): Promise<void> {
  try {
    await ExpoSecureStore.setItemAsync(key, value, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportAndRethrow('write', error);
  }
}

export async function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void> {
  try {
    await ExpoSecureStore.deleteItemAsync(key, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportAndRethrow('delete', error);
  }
}

export function getItem(key: string, options?: SecureStoreOptions): string | null {
  try {
    return ExpoSecureStore.getItem(key, ...secureStoreOptionsArgs(options));
  } catch (error) {
    return reportAndRethrow('read', error);
  }
}

export function setItem(key: string, value: string, options?: SecureStoreOptions): void {
  try {
    ExpoSecureStore.setItem(key, value, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportAndRethrow('write', error);
  }
}
