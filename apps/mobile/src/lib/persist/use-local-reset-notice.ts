import { useCallback, useEffect, useRef, useState } from 'react';

import { clearPersistedResetNotice, readPersistedResetNotice } from '@/lib/persist/encrypted-kv';

/** The notice's own state: a read that has not answered, no loss, or a loss to explain. */
type LocalResetNotice =
  | { readonly kind: 'loading' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'present' };

/** What the chat list needs from the marker: the notice's state and the dismissal it offers. */
export type LocalResetNoticeState = {
  readonly notice: LocalResetNotice;
  readonly dismiss: () => void;
};

/**
 * Whether the encrypted store was reset on this device and the person has not
 * dismissed the explanation yet.
 *
 * The marker is durable and is cleared only by {@link dismiss}, so the notice
 * outlives the render that found it and every relaunch until the person acts
 * on it: a loss this large must not vanish because the app was backgrounded
 * over it. A dismissal clears the marker fire-and-forget; a clear the keychain
 * refuses is harmless, because the marker stays and the notice simply returns
 * on the next launch instead of the dismissal being reported as a failure the
 * person cannot act on.
 *
 * The read is fenced by a mount token: an instance that unmounts publishes
 * nothing, and a read that lands after a dismissal leaves the notice dismissed
 * instead of painting it back over the person's decision.
 */
export function useLocalResetNotice(): LocalResetNoticeState {
  const [notice, setNotice] = useState<LocalResetNotice>({ kind: 'loading' });
  // The current read's token. Cleanup and `dismiss` both bump it, so a read
  // that resolves afterwards is stale and never applied.
  const readTokenRef = useRef(0);

  useEffect(() => {
    readTokenRef.current += 1;
    const token = readTokenRef.current;
    void (async () => {
      const present = await readPersistedResetNotice();
      if (readTokenRef.current === token) {
        setNotice({ kind: present ? 'present' : 'absent' });
      }
    })();
    return () => {
      readTokenRef.current += 1;
    };
  }, []);

  const dismiss = useCallback(() => {
    // Bump the token before publishing: a read still in flight must not put
    // the notice back after this dismissal.
    readTokenRef.current += 1;
    setNotice({ kind: 'absent' });
    // `clearPersistedResetNotice` never throws; a refused clear leaves the
    // marker, so the notice returns on the next launch.
    void clearPersistedResetNotice();
  }, []);

  return { notice, dismiss };
}
