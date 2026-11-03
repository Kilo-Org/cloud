// The per-intent operation key for every ledgered mutation (P1-A-08). The RAW
// server markers and their predicate live in `@/lib/operation-markers`, which
// stays free of React and native imports; this module only owns the hook.

import * as Crypto from 'expo-crypto';
import { useRef } from 'react';

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
