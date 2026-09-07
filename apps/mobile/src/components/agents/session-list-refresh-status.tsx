import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SessionListRefreshStatusProps = {
  /** A pull or retry is in flight: show the visible "Updating" line. */
  busy: boolean;
  /** The last refresh failed: show "Couldn't refresh" with an inline Retry. */
  failed: boolean;
  onRetry: () => void;
  className?: string;
};

/**
 * The Agents lists' reserved refresh-status line. It always occupies the
 * height of its final (failure) state, so Updating -> idle and
 * idle -> "Couldn't refresh" swaps never move the rows below it (the UX
 * rule the invisible 1x1 status nodes broke on device).
 */
export function SessionListRefreshStatus({
  busy,
  failed,
  onRetry,
  className,
}: Readonly<SessionListRefreshStatusProps>) {
  const { t } = useTranslation();
  const showRetry = failed && !busy;
  let message: string | null = null;
  if (busy) {
    message = t('agents.sessionList.updating');
  } else if (showRetry) {
    // The line's full accessibility label must stay exactly this copy: the
    // device verifier asserts the full label, not a substring. The shared
    // `common.couldNotRefresh` carries the pull-down guidance for the toast
    // screens; this line has its own Retry action beside it instead.
    message = t('agents.sessionList.couldNotRefresh');
  }
  return (
    <View className={cn('h-5 flex-row items-center gap-2', className)}>
      <AccessibleStatus
        message={message}
        tone={busy ? 'status' : 'error'}
        className="flex-1 shrink text-xs"
      />
      {showRetry ? (
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
      ) : null}
    </View>
  );
}
