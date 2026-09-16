import { useEffect, useState } from 'react';

import { readStoredValue } from '@/lib/auth/secure-store-value';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

/**
 * The account that owns this device's persisted caches, when the live identity
 * is not confirmed.
 *
 * `user.getMe` answers first: live once the account is confirmed, or restored
 * from the encrypted read cache on a cold start. When neither holds — the API
 * is unreachable and the read cache did not restore — the persisted identity
 * hint answers instead. That hint is written only after an authoritative
 * `user.getMe` for the current credentials and deleted on sign-out, so it names
 * the account whose `cache:<userId>:` scope holds the device's transcript and
 * translations. Without it an offline open has no account to read the persisted
 * transcript with, and the session paints nothing.
 *
 * `fence` is the owner's auth epoch: the hint is re-read when the account
 * session moves, so an id read before a sign-out can never scope the next
 * account's local data.
 */
export function useRestoredAccountId(fence: number): string | null {
  const { userId } = useCurrentUserId();
  const [hintedUserId, setHintedUserId] = useState<string | null>(null);

  useEffect(() => {
    // The confirmed account already answered: there is no hint to read.
    if (userId !== undefined) {
      setHintedUserId(null);
      return undefined;
    }
    let cancelled = false;

    const readHint = async () => {
      try {
        const stored = await readStoredValue(ACTIVE_USER_ID_KEY);
        if (cancelled) {
          return;
        }
        setHintedUserId(stored === null || stored === '' ? null : stored);
      } catch {
        // A keystore failure leaves the live or restored id to answer.
      }
    };

    setHintedUserId(null);
    void readHint();
    return () => {
      cancelled = true;
    };
  }, [fence, userId]);

  return userId ?? hintedUserId ?? null;
}
