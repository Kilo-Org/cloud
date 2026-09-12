import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { ActionSheetIOS, Platform } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

import { collectCopyableText } from './collect-copyable-text';

export function useMessageCopy() {
  const copyMessage = useCallback(async (message: StoredMessage) => {
    const text = collectCopyableText(message);
    if (!text) {
      return;
    }

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [i18n.t('agentChat.messageDetails.copyText'), i18n.t('common.cancel')],
          cancelButtonIndex: 1,
        },
        buttonIndex => {
          if (buttonIndex === 0) {
            void performCopy(text);
          }
        }
      );
      return;
    }

    await performCopy(text);
  }, []);

  return { copyMessage };
}

/**
 * Android's system clipboard preview (Android 13+) covers the bottom-center
 * toast region for roughly six seconds after a copy, so a default-length
 * success toast is hidden for its entire life on those devices. Keep the
 * confirmation up long enough to be seen once the preview clears.
 */
const COPY_TOAST_DURATION_MS = 8000;

/**
 * Immediate clipboard write used by the message-details sheet and by the
 * a11y/ActionSheet copy path after the user confirms. Success haptic + toast;
 * failure → error toast (caller keeps its UI open).
 */
export async function performCopy(text: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.success(i18n.t('common.copiedToClipboard'), { duration: COPY_TOAST_DURATION_MS });
  } catch {
    toast.error(i18n.t('common.couldNotCopyToClipboard'));
  }
}
