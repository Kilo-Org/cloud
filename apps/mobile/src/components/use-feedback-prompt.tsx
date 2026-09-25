import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { FeedbackPromptDialog } from '@/components/feedback-prompt-dialog';
import { showFeedbackPrompt } from '@/lib/feedback';
import { needsInAppFeedbackPrompt } from '@/lib/feedback-prompt-platform';

/**
 * Where the one-time feedback prompt appears: the native alert on iOS, the
 * in-app dialog on Android (`feedback-prompt-platform.ts` explains why). A
 * caller renders `promptDialog` in its own tree and calls `requestPrompt`
 * where the prompt is triggered, passing the user id the claim carries.
 *
 * `requestPrompt` reports whether it presented. The in-app dialog is state in
 * this host, so a request that arrives after the host unmounted cannot render
 * — the deferred post-submit claim can outlive the layout that hosts it — and
 * it reports `false`, which leaves the one-time marker unset
 * (`maybeAskAfterSuccessfulOutcome`) so the next successful outcome asks
 * again. The native alert presents regardless of the tree, so it reports
 * `true`.
 */
export function useFeedbackPrompt() {
  const [isOpen, setIsOpen] = useState(false);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const requestPrompt = useCallback((nextUserId: string | undefined) => {
    if (!needsInAppFeedbackPrompt()) {
      showFeedbackPrompt(nextUserId);
      return true;
    }
    if (!isMountedRef.current) {
      return false;
    }
    setUserId(nextUserId);
    setIsOpen(true);
    return true;
  }, []);
  const promptDialog = isOpen ? (
    <FeedbackPromptDialog
      userId={userId}
      onDismiss={() => {
        setIsOpen(false);
      }}
    />
  ) : null;
  return { requestPrompt, promptDialog };
}

/** Reports whether the prompt presented; `false` leaves the one-time marker unset. */
type FeedbackPromptRequester = (userId: string | undefined) => boolean;

const FeedbackPromptRequestContext = createContext<FeedbackPromptRequester | undefined>(undefined);

/**
 * Hosts the prompt in a tree that outlives the surface that triggers it. The
 * review-submit formSheet dismisses (`router.back`) before its deferred
 * one-time claim runs (`pr-review-submit.tsx`), so the sheet requests through
 * this provider instead of hosting the dialog in its own tree — the dialog's
 * host would unmount with the sheet before the claim ever presents, and the
 * Android prompt would never render. The PR-review layouts mount the provider
 * above their Stack, so the host stays mounted across the sheet's dismissal
 * and the prompt presents over the overview screen that remains.
 */
export function FeedbackPromptProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { requestPrompt, promptDialog } = useFeedbackPrompt();
  return (
    <FeedbackPromptRequestContext.Provider value={requestPrompt}>
      {children}
      {promptDialog}
    </FeedbackPromptRequestContext.Provider>
  );
}

/** Requests the prompt through the surviving host (see `FeedbackPromptProvider`). */
export function useFeedbackPromptRequest(): FeedbackPromptRequester {
  const requestPrompt = useContext(FeedbackPromptRequestContext);
  if (!requestPrompt) {
    throw new Error('useFeedbackPromptRequest requires a FeedbackPromptProvider ancestor.');
  }
  return requestPrompt;
}
