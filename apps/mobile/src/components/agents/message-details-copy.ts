import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Details-sheet Copy path: immediate clipboard write, no ActionSheet, and no
 * app-root toast. The sheet is a full-window RN Modal on Android — a separate
 * native layer above the app-root Toaster — so a sonner toast never becomes
 * visible while it is open. `MessageDetailsSheet` renders the outcome inline
 * from this boolean instead.
 */
export async function handleMessageDetailsCopy(
  copyableText: string | null | undefined
): Promise<boolean> {
  if (!copyableText) {
    return false;
  }
  try {
    const copied = await Clipboard.setStringAsync(copyableText);
    if (!copied) {
      return false;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return true;
  } catch {
    return false;
  }
}

type CopyFeedbackState = 'idle' | 'copied' | 'failed';

function copyStatusLabel(state: CopyFeedbackState, t: (key: string) => string): string | null {
  if (state === 'copied') {
    return t('common.copiedToClipboard');
  }
  if (state === 'failed') {
    return t('common.couldNotCopyToClipboard');
  }
  return null;
}

/**
 * Inline Copy outcome for the details sheet. sonner toasts render in the app
 * root, behind this Modal's own native window on Android, so the sheet shows
 * the outcome itself instead of relying on the toast (the same P2 pattern the
 * context sheet's copy rows use). Closing the sheet or switching messages
 * clears the feedback and invalidates a pending copy, so a reopen starts from
 * the call to action even if an earlier copy finishes late.
 */
export function useMessageDetailsCopyFeedback(visible: boolean, messageId: string | null) {
  const { t } = useTranslation();
  const [state, setState] = useState<CopyFeedbackState>('idle');
  const generation = useRef(0);
  useEffect(() => {
    setState('idle');
    return () => {
      generation.current += 1;
    };
  }, [visible, messageId]);
  return {
    state,
    status: copyStatusLabel(state, t),
    handleCopy: (copyText: string | null | undefined) => {
      void (async () => {
        const current = generation.current;
        const success = await handleMessageDetailsCopy(copyText);
        if (current === generation.current) {
          setState(success ? 'copied' : 'failed');
        }
      })();
    },
  };
}
