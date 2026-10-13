import { useActionSheet } from '@expo/react-native-action-sheet';
import { type KiloChatClient } from '@kilocode/kilo-chat';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { useConfirmDialog } from '@/components/ui/dialog';
import { i18n } from '@/i18n';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';

import { useConversationRename } from './use-conversation-rename';
import { useLeaveConversation } from './use-conversations';

// Backs the conversation header's "..." options sheet: rename (via
// useConversationRename) and leave (with an in-app confirm + redirect).
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
  const themedSheet = useThemedActionSheetOptions();
  const { showActionSheetWithOptions } = useActionSheet();
  const { confirm, dialog: leaveDialog } = useConfirmDialog();
  const leaveConversation = useLeaveConversation(client);
  const rename = useConversationRename(client, conversationId, sandboxId);

  const openOptions = useCallback(() => {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        ...themedSheet,
        title: conversationTitle,
        options: [
          i18n.t('common.rename'),
          i18n.t('chat.conversation.leave'),
          i18n.t('common.cancel'),
        ],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
      },
      index => {
        if (index === 0) {
          rename.openRename();
          return;
        }
        if (index === 1) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          confirm({
            title: i18n.t('chat.conversation.leaveTitle'),
            message: i18n.t('chat.conversation.leaveMessage'),
            confirmLabel: i18n.t('chat.conversation.leave'),
            onConfirm: () => {
              leaveConversation.mutate(
                { conversationId, sandboxId },
                {
                  onSuccess: () => {
                    router.replace(chatSandboxPath(sandboxId));
                  },
                }
              );
            },
          });
        }
      }
    );
  }, [
    confirm,
    conversationId,
    conversationTitle,
    leaveConversation,
    rename,
    router,
    sandboxId,
    showActionSheetWithOptions,
    themedSheet,
  ]);

  return {
    leaveDialog,
    openOptions,
    renaming: rename.renaming,
    closeRename: rename.closeRename,
    saveRename: rename.saveRename,
  };
}
