import { type StoredValueRead } from '@/lib/auth/secure-store-value';
import { isProtectedDataAvailable } from '@/lib/protected-data';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * Gated SecureStore calls on a store the caller resolves.
 *
 * `lib/auth/secure-store-value` applies this same policy to the native module,
 * but it imports `expo-secure-store` at module load, and the modules that own
 * their store (the glanceable mirrors, the session-card scope records) are
 * imported by pure suites that must not load that graph. They hand their own
 * accessor to this module instead, so their calls still pass the one
 * protected-data gate and the one report: a locked device skips the keychain
 * call rather than collecting a refusal, and a failure that is not a refusal is
 * filed once, named by the operation that failed.
 *
 * The accessor runs inside the call rather than at the caller. Those modules
 * resolve their store lazily, so resolving it can itself fail, and a mirror
 * write that is never awaited must not reject: both the resolution and the call
 * land in the same catch.
 *
 * A call skipped while locked reads as an unreadable value, never as "nothing
 * stored": an absent record and a record the app cannot reach must stay
 * distinguishable by every caller that acts on the difference.
 */

/** The SecureStore surface a caller supplies; the native module satisfies it. */
export type GatedSecureStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/**
 * Total read: `null` while the device is locked or when the read failed. For a
 * caller whose outcome is the same whether the value is absent or unreadable.
 */
export async function readGatedValue(
  resolveStore: () => GatedSecureStore,
  key: string
): Promise<string | null> {
  if (!isProtectedDataAvailable()) {
    return null;
  }
  try {
    return await resolveStore().getItemAsync(key);
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return null;
  }
}

/**
 * Read for a read-modify-write: `'unreadable'` while the device is locked or
 * when the read failed, so the caller never persists a record derived from a
 * value it never read.
 */
export async function readGatedValueForUpdate(
  resolveStore: () => GatedSecureStore,
  key: string
): Promise<StoredValueRead> {
  if (!isProtectedDataAvailable()) {
    return { status: 'unreadable' };
  }
  try {
    return { status: 'value', value: await resolveStore().getItemAsync(key) };
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return { status: 'unreadable' };
  }
}

/**
 * Total write: `false` while the device is locked or when the write failed. For
 * a mirror whose in-memory value is authoritative, so a skipped write costs the
 * next restore rather than the caller's operation.
 */
export async function writeGatedValue(
  resolveStore: () => GatedSecureStore,
  key: string,
  value: string
): Promise<boolean> {
  if (!isProtectedDataAvailable()) {
    return false;
  }
  try {
    await resolveStore().setItemAsync(key, value);
    return true;
  } catch (error) {
    reportSecureStoreFailure('write', error);
    return false;
  }
}
