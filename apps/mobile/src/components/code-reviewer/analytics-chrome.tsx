import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Card } from '@/components/ui/card';
import { type LucideIcon } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SectionHeaderSkeleton } from '@/components/ui/section-header-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * The day window the dashboard covers. The label is the day count and its unit
 * in one existing catalog string — the same three the usage screen paints for
 * the same windows — so a segment reads "30 days" instead of a bare number the
 * reader cannot attribute to days.
 */
export const PERIOD_OPTIONS = [
  { value: '7', labelKey: 'spendAlerts.window7d' },
  { value: '30', labelKey: 'spendAlerts.window30d' },
  { value: '90', labelKey: 'usage.range90d' },
] as const;

export const PLATFORM_OPTIONS = (['github', 'gitlab'] as const).map(platform => ({
  value: platform,
  label: PLATFORM_CAPABILITIES[platform].label,
}));

/** One figure of the dashboard's two-by-two summary. */
export function MetricCard({
  icon: Icon,
  label,
  value,
}: Readonly<{ icon: LucideIcon; label: string; value: string }>) {
  const colors = useThemeColors();
  return (
    <Card className="min-w-0 flex-1 justify-between gap-1">
      <View className="flex-row items-center gap-2">
        <Icon size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="min-w-0 flex-1 text-xs" numberOfLines={2}>
          {label}
        </Text>
      </View>
      <Text variant="figure">{value}</Text>
    </Card>
  );
}

/**
 * The two caption lines under the cards. The skeleton paints the same two nodes
 * at zero opacity, so the band is reserved at the height this copy actually
 * wraps to: a line count written here would hold for one locale and one width
 * and under-reserve every longer translation.
 */
export function AnalyticsCaptions({
  uncapturedReviews,
  enrolledCompletedReviews,
  hidden = false,
}: Readonly<{
  uncapturedReviews: number;
  enrolledCompletedReviews: number;
  hidden?: boolean;
}>): ReactNode {
  const { t } = useTranslation();
  const number = (value: number) => formatNumber(value, i18n.language);
  // A reserved caption is invisible and inert: it holds the band, and neither
  // the eye nor a screen reader meets copy that is not on screen yet.
  const className = cn('text-xs', hidden && 'opacity-0');
  const hiddenProps = hidden
    ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
    : {};
  return (
    <>
      <Text variant="muted" className={className} {...hiddenProps}>
        {t('codeReviewer.analytics.trackedReviewsCaption')}
      </Text>
      <Text variant="muted" className={className} {...hiddenProps}>
        {t('codeReviewer.analytics.trackedReviewsUncounted', {
          count: uncapturedReviews,
          displayCount: number(uncapturedReviews),
          total: enrolledCompletedReviews,
          displayTotal: number(enrolledCompletedReviews),
        })}
      </Text>
    </>
  );
}

/**
 * The dashboard's first paint: the body alone. The platform and period controls
 * render outside the body in every state, so nothing stands in for them, and
 * every block the loaded body paints below the cards — the two caption lines and
 * the labelled repository group — is reserved here at its own geometry.
 */
export function AnalyticsSkeleton(): ReactNode {
  return (
    <View className="gap-6">
      <View className="gap-3">
        <View className="flex-row gap-3">
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
        </View>
        <View className="flex-row gap-3">
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
        </View>
        {/* The loaded captions paint the same copy here at zero opacity, so the
            band under the cards is exact for every locale and width. */}
        <AnalyticsCaptions uncapturedReviews={0} enrolledCompletedReviews={0} hidden />
      </View>
      <View className="gap-3">
        <SectionHeaderSkeleton />
        <RowGroup leadingTile>
          {Array.from({ length: 2 }, (_, index) => (
            <RowSkeleton key={index} tile subtitle />
          ))}
        </RowGroup>
      </View>
    </View>
  );
}
