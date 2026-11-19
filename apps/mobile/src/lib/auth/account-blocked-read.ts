import { useEffect, useRef } from 'react';

import { setBlockedAccountActive } from '@/lib/auth/blocked-account-state';
import { isAccountBlockedTrpcError } from '@/lib/trpc-error';

/** What the latest current-user read attempt says about the account. */
export type AccountReadVerdict = 'refused-blocked' | 'answered' | 'unsettled';

/**
 * Classifies one current-user read attempt.
 *
 * The "it answered again" branch tests the error object and the id it carried,
 * never a timestamp: React Query keeps the previous success's `data` while a
 * refetch fails, so `dataUpdatedAt` still names the last answer on an attempt
 * that never reached the account, and a surface comparing timestamps would
 * read retained data as a fresh answer. `error == null` with an id present is
 * the only sound test that this attempt itself was answered.
 */
export function accountReadVerdict(error: unknown, userId: string | undefined): AccountReadVerdict {
  if (isAccountBlockedTrpcError(error)) {
    return 'refused-blocked';
  }
  if (error == null && userId !== undefined) {
    return 'answered';
  }
  return 'unsettled';
}

type BlockedAccountFromAccountReadInput = {
  /** The latest attempt's error object: only it carries the blocked verdict. */
  readonly error: unknown;
  /** The id the read answered with, absent until an attempt is answered. */
  readonly userId: string | undefined;
  /** False while there is no session, so an answer on this read proves nothing
   *  about the account the explanation belongs to. */
  readonly enabled: boolean;
  /** The read has an attempt in flight. An attempt that has not settled cannot
   *  answer, so it must not dismiss the explanation even if it also clears
   *  `error` for the duration (the overlay would flicker off and return on the
   *  next refusal). */
  readonly fetching: boolean;
  /** Run once on the transition from a raise this hook made to an answered
   *  read; the app uses it to refetch the surfaces whose reads were refused
   *  while the account was blocked. */
  readonly onAnswered?: () => void;
};

/**
 * Raises the blocked-account explanation from the current-user read, and
 * clears it once that read answers again.
 *
 * Only a raise this hook made is ever cleared here. The refresh route raises
 * the same flag before it tears the session down, and no session is left for a
 * later read to answer for, so an answered read must not dismiss that
 * explanation — sign-out or a new sign-in is its only exit. `enabled` is false
 * in exactly that state (no token), so even a cached answer cannot clear it.
 *
 * The clear also requires `!fetching`: only an attempt that has settled as an
 * answer dismisses the explanation. A retry in flight has not answered yet, so
 * treating its cleared error as an answer would drop the overlay and bring it
 * back on the next refusal.
 *
 * `onAnswered` runs only where the flag was actually cleared, so it fires once
 * per block — the reveal of the tree, not every successful read. It is held in
 * a ref refreshed each render rather than listed as a dependency: callers pass
 * an inline closure, and a dependency on its identity would re-run the effect
 * (and could refetch the tree) on every render of the layout.
 */
export function useBlockedAccountFromAccountRead(input: BlockedAccountFromAccountReadInput): void {
  const raisedHere = useRef(false);
  const onAnswered = useRef(input.onAnswered);
  onAnswered.current = input.onAnswered;
  const verdict = accountReadVerdict(input.error, input.userId);
  useEffect(() => {
    if (verdict === 'refused-blocked') {
      raisedHere.current = true;
      setBlockedAccountActive(true);
      return;
    }
    if (verdict === 'answered' && input.enabled && !input.fetching && raisedHere.current) {
      raisedHere.current = false;
      setBlockedAccountActive(false);
      onAnswered.current?.();
    }
  }, [verdict, input.enabled, input.fetching]);
}
