import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import  { type SyncBanner } from '@/lib/chat/sync/sync-service';

/**
 * The strip a synced chat wears while another device owns its next turn:
 * busy (mid-turn elsewhere, read-only), live (a runner takes the messages),
 * or diverged (both sides wrote; the local tail is parked until the person
 * discards it for the server log). One card, three wordings, so the three
 * states can never stack.
 */
export function ChatSyncBanner({
  banner,
  onDiscard,
}: {
  readonly banner: SyncBanner;
  readonly onDiscard: () => void;
}) {
  const { t } = useTranslation();
  if (banner.kind === 'none') {
    return null;
  }
  const copy =
    banner.kind === 'busy'
      ? { title: t('modelChat.sync.busyTitle'), body: t('modelChat.sync.busyBody') }
      : (banner.kind === 'live'
        ? { title: t('modelChat.sync.liveTitle'), body: t('modelChat.sync.liveBody') }
        : { title: t('modelChat.sync.divergedTitle'), body: t('modelChat.sync.divergedBody') });
  return (
    <View
      accessibilityRole="alert"
      testID={`chat-sync-banner-${banner.kind}`}
      className="mx-4 mt-2 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-4"
    >
      <Text className="text-base font-medium text-warn">{copy.title}</Text>
      <AccessibleStatus message={copy.body} tone="status" className="mt-2 text-base text-foreground" />
      {banner.kind === 'diverged' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('modelChat.sync.divergedAction')}
          className="mt-3 self-start rounded-md bg-primary px-3 py-2 active:opacity-70"
          onPress={onDiscard}
        >
          <Text className="text-sm font-medium text-primary-foreground">
            {t('modelChat.sync.divergedAction')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
