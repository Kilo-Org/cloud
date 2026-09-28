import * as SecureStore from 'expo-secure-store';

import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * The options a plain read accepts. Named here so the modules that build on
 * this read (the retrying credential read, the glanceable scope reads) need no
 * platform import of their own.
 */
export type SecureStoreReadOptions = SecureStore.SecureStoreOptions;

/**
 * Forward `options` only when the caller supplied it. `expo-secure-store`
 * defaults the argument itself, and callers (and the tests that mock them)
 * match on the exact argument list, so a call that passed no options must stay
 * a one-argument call.
 */
export function secureStoreOptionsArgs(
  options?: SecureStoreReadOptions
): [] | [SecureStoreReadOptions] {
  return options === undefined ? [] : [options];
}

/**
 * One read of `key`; a rejection propagates to the caller, which owns how the
 * failure is surfaced.
 *
 * This is the single cross-platform entry point for a plain SecureStore read:
 * `expo-secure-store` exists on both iOS and Android, so no platform lacks the
 * capability and there is no per-platform storage branch to keep. The retrying
 * credential read in `lib/auth/secure-store-read` and the glanceable scope
 * reads in `lib/glanceable/scope` both build on it, so the approving surface
 * and the push sink can never read different storage.
 *
 * A rejection is NOT "nothing stored": this raw read stays throwing for the
 * bounded-retry credential read, where a failed read must reach the
 * restore-error surface instead of presenting the person as signed out. Any
 * caller for which an unreadable value is the same recoverable outcome as an
 * absent one uses {@link readStoredValueSafe} instead, so a keychain failure
 * cannot reject into it.
 */
export async function readStoredValue(
  key: string,
  options?: SecureStoreReadOptions
): Promise<string | null> {
  const value = await SecureStore.getItemAsync(key, ...secureStoreOptionsArgs(options));
  return value;
}

/**
 * Total read: a failed read is reported at warning level and reads as
 * "nothing stored" instead of rejecting into the caller.
 *
 * Use this wherever absence and unreadability share one recoverable outcome
 * (a scope hint, a preference, a read-only cache lookup); the raw
 * {@link readStoredValue} is the exception reserved for the credential read,
 * which must tell the two apart. A read that feeds a read-modify-write uses
 * {@link readStoredValueForUpdate} instead — it keeps the two apart, because a
 * mutation that persisted a value derived from an unreadable record would
 * overwrite the record it could not read.
 */
export async function readStoredValueSafe(
  key: string,
  options?: SecureStoreReadOptions
): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return null;
  }
}

/**
 * The outcome of a read that feeds a read-modify-write. `'value'` carries the
 * stored string (`null` for nothing stored); `'unreadable'` means the read
 * failed and was reported at warning level.
 */
export type StoredValueRead =
  | { readonly status: 'value'; readonly value: string | null }
  | { readonly status: 'unreadable' };

/**
 * Read for a read-modify-write. Unlike {@link readStoredValueSafe}, this keeps
 * "nothing stored" (`'value'` with `null`) and "could not read" (`'unreadable'`)
 * apart, so a mutation can abort instead of persisting a record derived from a
 * value it never read — which would overwrite the stored record with one that
 * never contained its entries.
 */
export async function readStoredValueForUpdate(
  key: string,
  options?: SecureStoreReadOptions
): Promise<StoredValueRead> {
  try {
    const value = await SecureStore.getItemAsync(key, ...secureStoreOptionsArgs(options));
    return { status: 'value', value };
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return { status: 'unreadable' };
  }
}

/**
 * Total write: a failed write is reported at warning level and returned as
 * `false` instead of rejecting into the caller.
 *
 * Use this where the in-memory value is authoritative or the caller has its
 * own recoverable fallback. Credential persistence deliberately keeps its
 * rejection — it must reach the sign-in error state — and reports through
 * {@link writeStoredValue} instead.
 */
export async function writeStoredValueSafe(
  key: string,
  value: string,
  options?: SecureStoreReadOptions
): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value, ...secureStoreOptionsArgs(options));
    return true;
  } catch (error) {
    reportSecureStoreFailure('write', error);
    return false;
  }
}

/** Total delete: a failed delete is reported at warning level and returned as
 *  `false` instead of rejecting into the caller. */
export async function deleteStoredValueSafe(
  key: string,
  options?: SecureStoreReadOptions
): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key, ...secureStoreOptionsArgs(options));
    return true;
  } catch (error) {
    reportSecureStoreFailure('delete', error);
    return false;
  }
}

/**
 * Write whose failure the caller must observe: the rejection is reported once
 * at warning level and then rethrown, so the caller can take the person to its
 * recoverable state (the sign-in persist error, the "couldn't save setting"
 * toast). Never use it for a fire-and-forget mirror — those call a `*Safe`
 * helper above.
 */
export async function writeStoredValue(
  key: string,
  value: string,
  options?: SecureStoreReadOptions
): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportSecureStoreFailure('write', error);
    throw error;
  }
}

/** {@link writeStoredValue} for a delete: reported at warning level and still
 *  rejected, for callers that own the recoverable outcome. */
export async function deleteStoredValue(
  key: string,
  options?: SecureStoreReadOptions
): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key, ...secureStoreOptionsArgs(options));
  } catch (error) {
    reportSecureStoreFailure('delete', error);
    throw error;
  }
}
