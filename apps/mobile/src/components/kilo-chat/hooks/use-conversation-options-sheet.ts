import { useActionSheet } from '@expo/react-native-action-sheet';
import { type KiloChatClient } from '@kilocode/kilo-chat';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chatSandboxPath } from '@/lib/kilo-chat-routes';

import { useConversationRename } from './use-conversation-rename';
import { useLeaveConversation } from './use-conversations';

// Backs the conversation header's "..." options sheet: rename (via
// useConversationRename) and leave (with a native confirm + redirect).
export function useConversationOptionsSheet({
  client,
  conversationId,
  sandboxId,
  conversationTitle,
}: {
  client: KiloChatClient;
  conversationId: string;
  sandboxId: string;
  conversationTitle: string;
}) {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const leaveConversation = useLeaveConversation(client);
  const rename = useConversationRename(client, conversationId, sandboxId);

  const openOptions = useCallback(() => {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        title: conversationTitle,
        options: ['Rename', 'Leave', 'Cancel'],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          rename.openRename();
          return;
        }
        if (index === 1) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          Alert.alert('Leave conversation?', 'This removes it from your list.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Leave',
              style: 'destructive',
              onPress: () => {
                leaveConversation.mutate(
                  { conversationId, sandboxId },
                  {
                    onSuccess: () => {
                      router.replace(chatSandboxPath(sandboxId));
                    },
                  }
                );
              },
            },
          ]);
        }
      }
    );
  }, [
    bottom,
    conversationId,
    conversationTitle,
    leaveConversation,
    rename,
    router,
    sandboxId,
    showActionSheetWithOptions,
  ]);

  return {
    openOptions,
    renaming: rename.renaming,
    closeRename: rename.closeRename,
    saveRename: rename.saveRename,
  };
}
