import { type StoredMessage } from 'cloud-agent-sdk';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { ActionSheetIOS, Platform } from 'react-native';
import { toast } from 'sonner-native';

import { collectCopyableText } from './collect-copyable-text';

export function useMessageCopy() {
  const copyMessage = useCallback(async (message: StoredMessage) => {
    const text = collectCopyableText(message);
    if (!text) {
      return;
    }

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Copy Text', 'Cancel'], cancelButtonIndex: 1 },
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

async function performCopy(text: string) {
  try {
    await Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Could not copy to clipboard');
  }
}
