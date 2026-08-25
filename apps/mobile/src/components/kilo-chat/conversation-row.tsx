import { useActionSheet } from '@expo/react-native-action-sheet';
import { CONVERSATION_TITLE_MAX_CHARS, type ConversationListItem } from '@kilocode/kilo-chat';
import * as Haptics from 'expo-haptics';
import { MessageSquare, MoreVertical } from '@/components/ui/icons';
import { Alert, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RenameModal } from '@/components/rename-modal';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { timeAgo } from '@/lib/utils';

import { useConversationRename } from './hooks/use-conversation-rename';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';

type ConversationRowProps = {
  conversation: ConversationListItem;
  sandboxId: string;
  onPress: (conversationId: string) => void;
  onLeave: (conversationId: string) => void;
};

function conversationTimestamp(conversation: ConversationListItem): number {
  return conversation.lastActivityAt ?? conversation.joinedAt;
}

function hasUnread(conversation: ConversationListItem): boolean {
  return (
    conversation.lastActivityAt !== null &&
    (conversation.lastReadAt === null || conversation.lastReadAt < conversation.lastActivityAt)
  );
}

export function ConversationRow({
  conversation,
  sandboxId,
  onPress,
  onLeave,
}: Readonly<ConversationRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const client = useKiloChatClient();
  const { renaming, openRename, closeRename, saveRename } = useConversationRename(
    client,
    conversation.conversationId,
    sandboxId
  );
  const title = conversation.title ?? t('chat.conversation.untitledConversation');

  function confirmLeave() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(t('chat.conversation.leaveTitle'), t('chat.conversation.leaveMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.conversation.leave'),
        style: 'destructive',
        onPress: () => {
          onLeave(conversation.conversationId);
        },
      },
    ]);
  }

  function openActions() {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        title: title,
        options: [t('chat.conversation.rename'), t('chat.conversation.leave'), t('common.cancel')],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          openRename();
        } else if (index === 1) {
          confirmLeave();
        }
      }
    );
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={t('chat.conversation.openHint')}
        className="min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:opacity-80"
        onPress={() => {
          onPress(conversation.conversationId);
        }}
        onLongPress={openActions}
      >
        <View className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-secondary">
          <MessageSquare size={18} color={colors.mutedForeground} strokeWidth={1.75} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text
              className="min-w-0 flex-1 text-base font-semibold text-foreground"
              numberOfLines={1}
            >
              {title}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {hasUnread(conversation) ? (
              <View
                className="h-2.5 w-2.5 rounded-full bg-primary"
                accessibilityLabel={t('chat.conversation.unread')}
              />
            ) : null}
            <Text variant="muted" numberOfLines={1}>
              {timeAgo(new Date(conversationTimestamp(conversation)))}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.conversation.optionsFor', { title })}
          hitSlop={8}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
          onPress={openActions}
        >
          <MoreVertical size={20} color={colors.mutedForeground} />
        </Pressable>
      </Pressable>
      {renaming && (
        <RenameModal
          title={t('chat.conversation.renameTitle')}
          placeholder={t('chat.conversation.renamePlaceholder')}
          initialValue={conversation.title ?? ''}
          maxLength={CONVERSATION_TITLE_MAX_CHARS}
          onSave={saveRename}
          onClose={closeRename}
        />
      )}
    </>
  );
}
