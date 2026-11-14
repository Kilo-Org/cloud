import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';

import { notificationHaptic } from '@/lib/haptics';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { assertSurfaceFailureHandled, type SurfaceFeedback } from '@/lib/surface-feedback';

/** The clipboard's refusal; the line under Copy renders it. */
type CopyFailure = { readonly kind: 'copy-failed' };

/**
 * Details-sheet Copy path: immediate clipboard write, no ActionSheet, and no
 * app-root toast. The sheet is a full-window RN Modal on Android — a separate
 * native layer above the app-root Toaster — so a sonner toast never becomes
 * visible while it is open. The sheet renders the outcome inline instead.
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
    notificationHaptic(Haptics.NotificationFeedbackType.Success);
    return true;
  } catch {
    return false;
  }
}

function copyStatusLabel(
  feedback: SurfaceFeedback<CopyFailure>,
  t: (key: string) => string
): string | null {
  switch (feedback.status) {
    case 'failed': {
      // One refusal arm: the line under Copy is the whole surface for it.
      return t('common.couldNotCopyToClipboard');
    }
    case 'succeeded': {
      return t('common.copiedToClipboard');
    }
    case 'idle':
    case 'pending': {
      return null;
    }
    default: {
      return assertSurfaceFailureHandled(feedback);
    }
  }
}

/**
 * Inline Copy outcome for the details sheet. sonner toasts render in the app
 * root, behind this Modal's own native window on Android, so the surface shows
 * the outcome itself instead of relying on the toast (the same pattern the
 * context sheet's copy rows use).
 *
 * The feedback belongs to one rendered block: the sheet mounts this owner with a
 * `key` per message and per visibility, so a reopen or a different message
 * starts from the call to action without a lifecycle reset, and a write that
 * settles after the block went away publishes nothing.
 */
/** What the Copy block renders and calls. */
export type MessageDetailsCopyFeedback = Readonly<{
  feedback: SurfaceFeedback<CopyFailure>;
  status: string | null;
  handleCopy: (copyText: string | null | undefined) => void;
}>;

export function useMessageDetailsCopyFeedback(): MessageDetailsCopyFeedback {
  const { t } = useTranslation();
  const copies = useSurfaceFeedback<CopyFailure>();
  return {
    feedback: copies.feedback,
    status: copyStatusLabel(copies.feedback, t),
    handleCopy: (copyText: string | null | undefined) => {
      const attempt = copies.begin();
      if (attempt === null) {
        // One write at a time: the first press owns the feedback line.
        return;
      }
      void (async () => {
        const success = await handleMessageDetailsCopy(copyText);
        if (success) {
          attempt.succeed();
        } else {
          attempt.fail({ kind: 'copy-failed' });
        }
      })();
    },
  };
}
