import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type Props = {
  onRetry: () => void;
  onDismiss: () => void;
};

/**
 * Inline row a composer shows when a staged attachment could not be attached.
 * The staged payload is still stored under the route's share id, so Retry
 * re-delivers the same files; Dismiss clears it, so no unreachable entry
 * outlives the screen. Neither control replaces the composer or the draft.
 */
export function SharePrefillFailure({ onRetry, onDismiss }: Props) {
  const { t } = useTranslation();

  return (
    <View className="mx-3 mt-2 flex-row items-center gap-2 rounded-md border border-danger-tile-border bg-danger-tile-bg px-3">
      <Text className="min-w-0 flex-1 text-xs text-destructive">
        {t('chat.attachment.attachFailed')}
      </Text>
      <Pressable
        className={cn(STATE_ACTION_CLASS, 'justify-center px-2 active:opacity-70')}
        accessibilityRole="button"
        accessibilityLabel={t('common.retry')}
        onPress={onRetry}
      >
        <Text className="text-xs font-semibold text-foreground">{t('common.retry')}</Text>
      </Pressable>
      <Pressable
        className={cn(STATE_ACTION_CLASS, 'justify-center px-2 active:opacity-70')}
        accessibilityRole="button"
        accessibilityLabel={t('common.remove')}
        onPress={onDismiss}
      >
        <Text className="text-xs text-muted-foreground">{t('common.remove')}</Text>
      </Pressable>
    </View>
  );
}
