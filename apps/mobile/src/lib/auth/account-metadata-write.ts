import * as SecureStore from 'expo-secure-store';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { chainSave } from '@/lib/hooks/save-chain';

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

/**
 * Per-key serialized SecureStore delete with NO epoch fence: deletes must
 * always run, and FIFO per key guarantees a delete lands after any in-flight
 * write to the same key. A queued-but-unstarted write skips via its epoch
 * check, so a stale write can never outlive the delete.
 */
export async function deleteAccountMetadata(key: string): Promise<void> {
  await chainSave(key, async () => {
    await SecureStore.deleteItemAsync(key);
  });
}
