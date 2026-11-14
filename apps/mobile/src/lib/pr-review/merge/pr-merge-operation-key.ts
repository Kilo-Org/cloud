/**
 * The merge domain's one retained operation-key store.
 *
 * A merge's key must outlive the merge screen: dismissing the sheet after an
 * ambiguous transport failure leaves the server's ledger row in place, so a
 * reopened sheet that submitted with a fresh key would let the server execute
 * the merge again instead of replaying the recorded outcome. The store is
 * per-domain (merge only), so the eight other `useHoistedOperationKey` callers
 * keep their independent per-mount keys.
 */

import * as Crypto from 'expo-crypto';

import { createRetainedOperationKeys } from '@/lib/operation-key-store';

const keys = createRetainedOperationKeys(() => Crypto.randomUUID());

/** The key for a merge intent, stable across mounts until the intent retires. */
export function mergeOperationKey(fingerprint: string): string {
  return keys.getKey(fingerprint);
}

/** Retires one merge intent after an authoritative outcome. */
export function retireMergeOperationKey(fingerprint: string): void {
  keys.retireKey(fingerprint);
}

/** The account boundary: one account never replays another's merge intent. */
export function clearMergeOperationKeys(): void {
  keys.clear();
}
