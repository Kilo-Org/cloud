// Intent-agnostic pieces of the operation ledger (P1-A-08). Every ledgered
// mutation — PR review, security sync, finding dismissal, session spawn —
// hoists one operation key per intent and receives the same raw server markers.
//
// Only the RAW markers live here. The user-facing copy for each marker is
// per-surface by design, so each surface maps these markers onto its own
// message instead of sharing one.

import * as Crypto from 'expo-crypto';
import { useRef } from 'react';

/** The ledger rejected a same-key request while the first one is still in flight. */
export const OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
/** The key was reused for a different intent, so the ledger refused to replay it. */
export const OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';

/** True when the failure is the in-flight duplicate marker. */
export function isOperationInProgress(error: unknown): boolean {
  return error instanceof Error && error.message === OPERATION_IN_PROGRESS_MESSAGE;
}

/**
 * Hoists one operation key per intent. `getKey(fingerprint)` is stable across
 * retries of the same fingerprint and rotates as soon as the fingerprint
 * changes, so an edited intent never replays the previous one's ledger result.
 * `rotateKey()` ends the intent after a success or a terminal failure.
 */
export function useHoistedOperationKey() {
  const keyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const getKey = (fingerprint: string) => {
    if (keyRef.current !== null && keyRef.current.fingerprint !== fingerprint) {
      keyRef.current = null;
    }
    keyRef.current ??= { fingerprint, key: Crypto.randomUUID() };
    return keyRef.current.key;
  };
  const rotateKey = () => {
    keyRef.current = null;
  };
  return { getKey, rotateKey };
}
