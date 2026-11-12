import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { LOCK_READABLE_METADATA_KEYS, widgetStoreOptions } from '@/lib/auth/secure-store-gated';
import { deleteStoredValue, writeStoredValue } from '@/lib/auth/secure-store-value';
import { chainSave } from '@/lib/hooks/save-chain';

/**
 * The account metadata written with the widget store's
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` class, so a push or background refresh
 * can resolve its scope with the screen locked: the two ids the glanceable
 * fences compare (`lib/glanceable/scope`). Every other key here keeps
 * expo-secure-store's default class.
 */
const lockReadableKeys: ReadonlySet<string> = new Set(LOCK_READABLE_METADATA_KEYS);

/**
 * Epoch-fenced, per-key serialized SecureStore write for account-scoped
 * metadata. The epoch is captured when the write is scheduled, so a write
 * queued behind an in-flight save for the same key skips entirely when a
 * sign-out (or sign-in) bumps the epoch before it runs.
 */
export async function writeAccountMetadata(key: string, write: () => Promise<void>): Promise<void> {
  const epoch = currentAuthEpoch();
  await chainSave(key, async () => {
    if (!isCurrentAuthEpoch(epoch)) {
      return;
    }
    await write();
  });
}

/** Epoch-fenced, per-key serialized write of one string value. A failed write
 *  is reported at warning level with the stable write fingerprint and still
 *  rejects, so a preference write can surface its own recoverable state. */
export async function setAccountMetadata(key: string, value: string): Promise<void> {
  await writeAccountMetadata(key, async () => {
    await writeStoredValue(
      key,
      value,
      lockReadableKeys.has(key) ? widgetStoreOptions() : undefined
    );
  });
}

/**
 * Per-key serialized SecureStore delete with NO epoch fence: deletes must
 * always run, and FIFO per key guarantees a delete lands after any in-flight
 * write to the same key. A queued-but-unstarted write skips via its epoch
 * check, so a stale write can never outlive the delete.
 */
export async function deleteAccountMetadata(key: string): Promise<void> {
  await chainSave(key, async () => {
    await deleteStoredValue(key);
  });
}
