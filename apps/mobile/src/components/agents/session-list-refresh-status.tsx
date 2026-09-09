import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SessionListRefreshStatusProps = {
  /** A pull or retry is in flight: announce Updating; the spinner is the visual. */
  busy: boolean;
  /** The last refresh failed: show "Couldn't refresh" with an inline Retry. */
  failed: boolean;
  onRetry: () => void;
  className?: string;
};

/**
 * Agents-list refresh status. Pull-in-flight copy is screen-reader only and
 * takes no layout: the native spinner is the visual. Failure shows
 * "Couldn't refresh" + Retry on its own line.
 */
export function SessionListRefreshStatus({
  busy,
  failed,
  onRetry,
  className,
}: Readonly<SessionListRefreshStatusProps>) {
  const { t } = useTranslation();
  const showRetry = failed && !busy;
  if (busy) {
    return (
      <AccessibleStatus
        message={t('agents.sessionList.updating')}
        tone="status"
        className="absolute size-px overflow-hidden"
      />
    );
  }
  if (!showRetry) {
    return null;
  }
  return (
    <View className={cn('h-5 flex-row items-center gap-2', className)}>
      <AccessibleStatus
        message={t('agents.sessionList.couldNotRefresh')}
        tone="error"
        className="flex-1 shrink text-xs"
      />
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={t('common.retry')}
        hitSlop={12}
        className="justify-center active:opacity-70"
      >
        <Text className="font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
          {t('common.retry')}
        </Text>
      </Pressable>
    </View>
  );
}
