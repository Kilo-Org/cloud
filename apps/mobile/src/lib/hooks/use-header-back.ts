import { type Href, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

import {
  claimHeaderBack,
  type HeaderBackGuardState,
  resolveHeaderBack,
} from '@/lib/hooks/header-back';

/** What a header declares about its Back press. */
export type HeaderBackOptions = Readonly<{
  onBack?: () => void;
  backFallback?: Href;
  canGoBack: boolean;
}>;

/**
 * The header's Back press, at most once per press burst and never when the
 * navigator has nowhere to pop.
 *
 * `ScreenHeader` used to run the dispatch on every press. A burst of presses
 * delivered to one header dispatched one `GO_BACK` each, so one gesture popped
 * the screens beneath the one the reader was on — and once the stack was at its
 * root the extra `GO_BACK` was spent on the tab navigator or was unhandled. The
 * window needs no reset when the screen regains focus, the way
 * `useSinglePushRoute` clears its push window: this claim belongs to a screen
 * that a dispatched back pops, and every further screen has its own guard, so
 * the only claim that outlives its press is one the screen walked back through
 * a confirmation, and 500 ms outlasts that press.
 */
export function useHeaderBack({ onBack, backFallback, canGoBack }: HeaderBackOptions): () => void {
  const router = useRouter();
  const guardRef = useRef<HeaderBackGuardState>({ lastBackAt: 0 });

  return useCallback(() => {
    const decision = resolveHeaderBack({
      hasHandler: onBack !== undefined,
      hasFallback: backFallback !== undefined,
      canGoBack,
    });
    // A press with nothing to run leaves the burst window untouched: it
    // dispatched no back, so the next press is still the first of its gesture.
    if (decision === 'none' || !claimHeaderBack(guardRef.current, Date.now())) {
      return;
    }
    if (decision === 'handler') {
      onBack?.();
      return;
    }
    if (decision === 'history') {
      router.back();
      return;
    }
    // Only 'fallback' reaches here: a press with nothing to run returned above.
    if (backFallback !== undefined) {
      // POP_TO keeps the fallback's contract (land on this destination) while
      // truncating any routes the app left above it; with no history it still
      // creates the destination.
      router.dismissTo(backFallback);
    }
  }, [backFallback, canGoBack, onBack, router]);
}
