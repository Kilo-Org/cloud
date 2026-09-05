import { useActionSheet } from '@expo/react-native-action-sheet';
import * as Haptics from 'expo-haptics';
import { Alert, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MessageCircle } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type ChatSummary } from '@/lib/chat/store';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { timeAgo } from '@/lib/utils';

/**
 * One chat in the list.
 *
 * A chat has no name of its own: the first thing the person said is what they
 * will recognise it by, which is what the store reads back. A chat with nothing
 * said in it yet is the one case that needs a word instead.
 */

type ChatRowProps = {
  chat: ChatSummary;
  modelName: string;
  onPress: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
};

export function ChatRow({ chat, modelName, onPress, onDelete }: Readonly<ChatRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const title = chat.title === '' ? t('modelChat.list.untitled') : chat.title;

  function confirmDelete() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(t('modelChat.list.deleteTitle'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('modelChat.list.delete'),
        style: 'destructive',
        onPress: () => {
          onDelete(chat.sessionId);
        },
      },
    ]);
  }

  function openActions() {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        title,
        options: [t('modelChat.list.delete'), t('common.cancel')],
        cancelButtonIndex: 1,
        destructiveButtonIndex: 0,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          confirmDelete();
        }
      }
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={t('modelChat.list.openHint')}
      className="min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:opacity-80"
      onPress={() => {
        onPress(chat.sessionId);
      }}
      onLongPress={openActions}
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-secondary">
        <MessageCircle size={18} color={colors.mutedForeground} strokeWidth={1.75} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="min-w-0 flex-1 text-base font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="muted" numberOfLines={1}>
          {modelName === ''
            ? timeAgo(new Date(chat.updatedAt))
            : `${modelName} · ${timeAgo(new Date(chat.updatedAt))}`}
        </Text>
      </View>
    </Pressable>
  );
}
