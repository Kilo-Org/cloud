import { useEffect } from 'react';
import { AppState } from 'react-native';

import { flushDraft } from '@/lib/persist/drafts';

/**
 * Flushes the debounced draft write for one entity key when the app leaves
 * `active`, so a backgrounded-then-killed app does not lose the last edits
 * inside the 500 ms window. `flushOnUnmount` adds the same flush to the effect
 * cleanup (unmount, or an identity/entity change), for hosts whose draft must
 * also survive navigating away; hosts that own the unmount fate themselves
 * (the new-session route, through `useRemoteSpawnDraftCleanup`) pass `false`.
 * The drafts module epoch-fences the write, so a sign-out that bumped the
 * epoch skips it. A no-op while the identity or the entity key is unknown.
 */
export function useDraftFlushOnBackground(
  userId: string | undefined,
  entityKey: string | undefined,
  flushOnUnmount: boolean
): void {
  useEffect(() => {
    if (!userId || !entityKey) {
      return undefined;
    }
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState !== 'active') {
        void flushDraft(userId, entityKey);
      }
    });
    return () => {
      subscription.remove();
      if (flushOnUnmount) {
        void flushDraft(userId, entityKey);
      }
    };
  }, [userId, entityKey, flushOnUnmount]);
}
