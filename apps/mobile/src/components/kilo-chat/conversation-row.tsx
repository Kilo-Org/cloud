import { useActionSheet } from '@expo/react-native-action-sheet';
import { CONVERSATION_TITLE_MAX_CHARS, type ConversationListItem } from '@kilocode/kilo-chat';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { MoreVertical } from 'lucide-react-native';
import { Alert, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { chatRenameConversationPath } from '@/lib/kilo-chat-routes';
import { timeAgo } from '@/lib/utils';

type ConversationRowProps = {
  conversation: ConversationListItem;
  sandboxId: string;
  onPress: (conversationId: string) => void;
  onLeave: (conversationId: string) => void;
};

function conversationTitle(conversation: ConversationListItem): string {
  return conversation.title ?? 'Untitled conversation';
}

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
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const title = conversationTitle(conversation);

  function openRenameSheet() {
    const params = new URLSearchParams({
      conversationId: conversation.conversationId,
      title: title.slice(0, CONVERSATION_TITLE_MAX_CHARS),
    });
    router.push(chatRenameConversationPath(sandboxId, params));
  }

  function confirmLeave() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert('Leave conversation?', 'This removes it from your list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
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
        options: ['Rename', 'Leave', 'Cancel'],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          openRenameSheet();
        } else if (index === 1) {
          confirmLeave();
        }
      }
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      className="min-h-16 flex-row items-center gap-3 rounded-xl px-3 py-3 active:bg-muted"
      onPress={() => {
        onPress(conversation.conversationId);
      }}
    >
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-semibold text-foreground"
            numberOfLines={1}
          >
            {title}
          </Text>
          {hasUnread(conversation) ? (
            <View className="h-2.5 w-2.5 rounded-full bg-primary" accessibilityLabel="Unread" />
          ) : null}
        </View>
        <Text className="mt-0.5 text-sm text-muted-foreground">
          {timeAgo(new Date(conversationTimestamp(conversation)))}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Conversation options for ${title}`}
        hitSlop={8}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
        onPress={openActions}
      >
        <MoreVertical size={20} color={colors.mutedForeground} />
      </Pressable>
    </Pressable>
  );
}
