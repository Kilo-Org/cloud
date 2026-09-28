import { Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { useProvidedMotionPolicy } from '@/lib/a11y/motion-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { nativeRefreshIndicatorIsInset } from './refresh-indicator';

type SessionListRefreshStatusProps = {
  /** A pull or retry is in flight: announce Updating, and show the inline
   * spinner where the platform draws none over the rows. */
  busy: boolean;
  /** The last refresh failed: show "Couldn't refresh" with an inline Retry. */
  failed: boolean;
  onRetry: () => void;
  /**
   * This pull's progress belongs to the surface's centered refreshable body
   * (the no-match body), which draws it itself while reduced motion is on:
   * the band then carries the "Updating" copy without a second spinner, one
   * indicator per pull. A retry reports no pull, so the band keeps the
   * spinner the body does not draw.
   */
  progressInBody?: boolean;
  className?: string;
};

/**
 * Agents-list refresh status. Where the platform's own pull-to-refresh
 * indicator is inset in the scroll content (`nativeRefreshIndicatorIsInset`),
 * the pull-in-flight copy is screen-reader only and takes no layout: that
 * indicator is the visual. Where it is not inset — Android, where it would
 * rest over the first row — the reserved band carries the in-flight spinner
 * and copy instead (device defect uxs1), unless the surface's centered body
 * draws the pull's progress itself (`progressInBody`). Failure shows
 * "Couldn't refresh" + Retry on its own line.
 */
export function SessionListRefreshStatus({
  busy,
  failed,
  onRetry,
  progressInBody = false,
  className,
}: Readonly<SessionListRefreshStatusProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const reducedMotion = useProvidedMotionPolicy()?.reducedMotion ?? false;
  // The body only draws that progress while the platform control is inert
  // (reduced motion), so only then can the band stand down its own spinner.
  const bodyDrawsProgress = progressInBody && reducedMotion;
  const showRetry = failed && !busy;
  if (busy) {
    if (nativeRefreshIndicatorIsInset(Platform.OS)) {
      return (
        <AccessibleStatus
          message={t('agents.sessionList.updating')}
          tone="status"
          className="absolute size-px overflow-hidden"
        />
      );
    }
    return (
      <View className={cn('h-5 flex-row items-center gap-2', className)}>
        {bodyDrawsProgress ? null : (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        )}
        <AccessibleStatus
          message={t('agents.sessionList.updating')}
          tone="status"
          className="flex-1 shrink text-xs"
        />
      </View>
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
