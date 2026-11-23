import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

/**
 * The one-time ask to sync chats, shown while the flag is on and the
 * per-account setting was never decided. Either answer is the decision:
 * the card never returns, and the setting itself lives on the profile
 * screen from then on.
 */
export function ChatSyncPromptCard({
  onDecide,
}: {
  readonly onDecide: (choice: 'on' | 'off') => void;
}) {
  const { t } = useTranslation();
  return (
    <View testID="chat-sync-prompt" className="mx-4 mt-2 rounded-xl bg-secondary p-4">
      <Text className="text-base font-medium">{t('modelChat.sync.promptTitle')}</Text>
      <Text variant="muted" className="mt-2">
        {t('modelChat.sync.promptBody')}
      </Text>
      <View className="mt-3 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('modelChat.sync.promptEnable')}
          className="rounded-md bg-primary px-3 py-2 active:opacity-70"
          onPress={() => {
            onDecide('on');
          }}
        >
          <Text className="text-sm font-medium text-primary-foreground">
            {t('modelChat.sync.promptEnable')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('modelChat.sync.promptDismiss')}
          className="rounded-md px-3 py-2 active:opacity-70"
          onPress={() => {
            onDecide('off');
          }}
        >
          <Text className="text-sm font-medium">{t('modelChat.sync.promptDismiss')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
