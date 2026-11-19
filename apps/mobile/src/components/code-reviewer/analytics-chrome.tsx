import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { type LucideIcon } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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

/** The dashboard's first paint: the segment row, four figure cards and two rows. */
export function AnalyticsSkeleton(): ReactNode {
  return (
    <View className="gap-6">
      <Skeleton className="h-10 w-full rounded-md bg-muted-soft" />
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
      </View>
      <RowGroup leadingTile>
        {Array.from({ length: 2 }, (_, index) => (
          <RowSkeleton key={index} tile subtitle />
        ))}
      </RowGroup>
    </View>
  );
}
