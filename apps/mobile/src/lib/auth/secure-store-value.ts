import * as SecureStore from 'expo-secure-store';

/**
 * The options a plain read accepts. Named here so the modules that build on
 * this read (the retrying credential read, the glanceable scope reads) need no
 * platform import of their own.
 */
export type SecureStoreReadOptions = SecureStore.SecureStoreOptions;

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
 * The module deliberately imports nothing else: the background push handler
 * reads storage without dragging the app config graph in behind it.
 */
export async function readStoredValue(
  key: string,
  options?: SecureStoreReadOptions
): Promise<string | null> {
  const value = await SecureStore.getItemAsync(key, options);
  return value;
}
