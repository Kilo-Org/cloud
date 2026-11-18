import { useEffect, useRef } from 'react';

import { restorePersistedPendingDeepLink } from '@/lib/deep-link-launch';

type PendingDeepLinkRestoreInput = {
  /** Auth bootstrap has not settled: the token owner publishes the signed-in
   *  user id before this clears, and a persisted record is account-bound. */
  readonly authLoading: boolean;
  /** Every retried startup credential read failed. The session is NOT known
   *  to be gone, so this is not a signed-out answer — the account binding is
   *  unknown, and the persisted-record restore must wait for bootstrap to
   *  settle into a known state. */
  readonly restoreFailed: boolean;
};

/**
 * Restore a deep-link destination persisted before process death, exactly
 * once, after auth bootstrap settles into a state where the account binding
 * is known.
 *
 * Restoring too early compares an account-bound record against a null user id
 * and deletes the destination:
 * - while `authLoading`, the signed-in user id is not published yet;
 * - while `restoreFailed`, the credential reads never resolved, so the
 *   binding is unknown — holding the restore keeps the record intact until
 *   the retry publishes it (the link then restores for the right account) or
 *   the sign-out escape hatch settles genuinely signed out (the restore then
 *   applies the signed-out semantics: drop account-bound, keep
 *   account-independent).
 *
 * The slot is observable, so the consumer still fires when the destination
 * lands.
 */
export function usePendingDeepLinkRestore(input: PendingDeepLinkRestoreInput): void {
  const startedRef = useRef(false);
  useEffect(() => {
    if (input.authLoading || input.restoreFailed || startedRef.current) {
      return;
    }
    startedRef.current = true;
    void restorePersistedPendingDeepLink();
  }, [input.authLoading, input.restoreFailed]);
}
