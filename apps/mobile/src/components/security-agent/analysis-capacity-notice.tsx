import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type SecurityAnalysisCapacityState } from '@/lib/security-analysis-capacity';
import { cn } from '@/lib/utils';

type AnalysisCapacityNoticeProps = {
  state: SecurityAnalysisCapacityState;
  /** Refetch the capacity counters; rendered only for the failed read. */
  onRetry: () => void;
  /** Spacing owned by the caller; it never applies in the hidden states. */
  className?: string;
};

/**
 * The one place that explains why an Analyze action is unavailable. Shared by
 * the findings list (once, above the rows) and the analysis panel (under the
 * action) so both surfaces word the same block identically.
 *
 * `available` and `loading` render nothing: loading shows on the action itself.
 */
export function AnalysisCapacityNotice({
  state,
  onRetry,
  className,
}: Readonly<AnalysisCapacityNoticeProps>) {
  const { t } = useTranslation();

  if (state === 'full') {
    return (
      <Text variant="muted" className={cn('text-xs', className)}>
        {t('securityAgent.analysis.capacityFull')}
      </Text>
    );
  }

  if (state === 'error') {
    return (
      <View className={cn('flex-row items-center gap-2', className)}>
        <Text variant="muted" className="text-xs">
          {t('securityAgent.analysis.couldNotCheckCapacity')}
        </Text>
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          // React Native clips hit slop to the parent's bounds, and the notice
          // row is only as tall as its text, so the control carries the app's
          // 48px floor itself instead of relying on a slop it cannot use.
          className={cn(STATE_ACTION_CLASS, 'items-center justify-center px-2')}
        >
          <Text className="text-xs font-medium text-primary">{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}
