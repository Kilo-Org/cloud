import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

import { FeedbackPromptDialog } from '@/components/feedback-prompt-dialog';
import { showFeedbackPrompt } from '@/lib/feedback';
import { needsInAppFeedbackPrompt } from '@/lib/feedback-prompt-platform';

/**
 * Where the one-time feedback prompt appears: the native alert on iOS, the
 * in-app dialog on Android (`feedback-prompt-platform.ts` explains why). A
 * caller renders `promptDialog` in its own tree and calls `requestPrompt`
 * where the prompt is triggered, passing the user id the claim carries.
 */
export function useFeedbackPrompt() {
  const [isOpen, setIsOpen] = useState(false);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const requestPrompt = useCallback((nextUserId: string | undefined) => {
    if (!needsInAppFeedbackPrompt()) {
      showFeedbackPrompt(nextUserId);
      return;
    }
    setUserId(nextUserId);
    setIsOpen(true);
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

type FeedbackPromptRequester = (userId: string | undefined) => void;

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
