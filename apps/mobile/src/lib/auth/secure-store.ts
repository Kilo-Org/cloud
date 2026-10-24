import * as ExpoSecureStore from 'expo-secure-store';

import {
  deleteStoredValue,
  readStoredValue,
  secureStoreOptionsArgs,
  type SecureStoreReadOptions,
  writeStoredValue,
} from '@/lib/auth/secure-store-value';
import { assertProtectedDataAvailable } from '@/lib/protected-data';
import {
  reportSecureStoreFailure,
  type SecureStoreOperation,
} from '@/lib/telemetry/secure-store-events';

/**
 * The guarded keychain entry point, as the app's modules import it.
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
 * While the device is locked every call rejects with an unreported
 * `ProtectedDataUnavailableError` and never reaches the keychain, which would
 * refuse it anyway (see `lib/protected-data`).
 *
 * Semantics are unchanged — the rejection still propagates, because each
 * caller owns its recoverable state (sign-in's persist error, the retryable
 * session-restore surface, a widget action's `failed`). A call whose failure
 * is the same recoverable outcome as an absent value uses the `*Safe` helpers
 * in `secure-store-value`, which never reject.
 *
 * The reporting layer in `lib/auth/secure-store-value` owns that policy for
 * the asynchronous calls, and the functions below delegate to it instead of
 * repeating it: one module decides the protected-data guard, the option
 * forwarding, the report fingerprint and the rethrow. The read below is the
 * one intended difference, since the layer's plain read stays silent for the
 * retrying credential read and reports here. The synchronous pair has no
 * counterpart there — the layer is asynchronous — so this module keeps that
 * one path, with the same guard and report.
 */

/** Report one failed operation and rethrow so the caller owns the outcome. */
function reportAndRethrow(operation: SecureStoreOperation, error: unknown): never {
  reportSecureStoreFailure(operation, error);
  throw error;
}

export async function getItemAsync(
  key: string,
  options?: SecureStoreReadOptions
): Promise<string | null> {
  // The guard stays outside the catch: a locked device is not a read failure
  // and must not file a report, exactly as the guard in `readStoredValue` does
  // not.
  assertProtectedDataAvailable();
  try {
    return await readStoredValue(key, options);
  } catch (error) {
    return reportAndRethrow('read', error);
  }
}

export async function setItemAsync(
  key: string,
  value: string,
  options?: SecureStoreReadOptions
): Promise<void> {
  await writeStoredValue(key, value, options);
}

export async function deleteItemAsync(
  key: string,
  options?: SecureStoreReadOptions
): Promise<void> {
  await deleteStoredValue(key, options);
}

export function getItem(key: string, options?: SecureStoreReadOptions): string | null {
  assertProtectedDataAvailable();
  try {
    return ExpoSecureStore.getItem(key, ...secureStoreOptionsArgs(options));
  } catch (error) {
    return reportAndRethrow('read', error);
  }
}

export function setItem(key: string, value: string, options?: SecureStoreReadOptions): void {
  assertProtectedDataAvailable();
  try {
    ExpoSecureStore.setItem(key, value, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportAndRethrow('write', error);
  }
}
