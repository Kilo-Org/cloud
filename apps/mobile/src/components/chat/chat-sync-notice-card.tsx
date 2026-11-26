import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';

/**
 * The one-time notice after upgrade: chats now sync unless the person turns
 * it off. It is not a prompt and gates nothing — sync already runs — and its
 * second sentence is the way to the setting. Dismissing it is remembered per
 * account, so it appears once.
 */
export function ChatSyncNoticeCard({
  onDismiss,
  onOpenSettings,
}: {
  readonly onDismiss: () => void;
  readonly onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View testID="chat-sync-notice" className="mx-4 mt-2 rounded-xl bg-secondary p-4">
      <Text className="text-base font-medium">{t('modelChat.sync.noticeBody')}</Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('modelChat.sync.noticeAction')}
        className={`mt-2 self-start justify-center active:opacity-70 ${ROW_TARGET_CLASS}`}
        onPress={onOpenSettings}
      >
        <Text variant="muted">{t('modelChat.sync.noticeAction')}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('modelChat.list.resetNoticeDismiss')}
        className={`mt-2 self-start justify-center rounded-md px-2 active:opacity-70 ${ROW_TARGET_CLASS}`}
        onPress={onDismiss}
      >
        <Text className="text-sm font-medium">{t('modelChat.list.resetNoticeDismiss')}</Text>
      </Pressable>
    </View>
  );
}
