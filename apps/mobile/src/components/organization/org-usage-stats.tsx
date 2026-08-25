import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatMoney, formatNumber } from '@/lib/format';
import { useOrgUsageStats } from '@/lib/hooks/use-organization-queries';

function StatTile({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <View className="flex-1 gap-1 rounded-lg bg-secondary px-3 py-3">
      <Text className="text-lg font-bold text-foreground">{value}</Text>
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

function StatTileSkeleton() {
  return (
    <View className="flex-1 gap-1 rounded-lg bg-secondary px-3 py-3">
      <Skeleton className="h-[22px] w-16 rounded-md" />
      <Skeleton className="h-4 w-20 rounded-md" />
    </View>
  );
}

type OrgUsageStatsProps = {
  organizationId: string;
};

/** "Last 30 days" eyebrow + 2x2 usage stat tile grid. Visible to all org roles. */
export function OrgUsageStats({ organizationId }: Readonly<OrgUsageStatsProps>) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useOrgUsageStats(organizationId);

  // An embedded stat block has no room for a retry affordance — hide the
  // section on a hard failure instead of showing a full QueryError. Stale
  // data from a prior successful load stays visible through a refetch error.
  if (isError && !data) {
    return null;
  }

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
        <View className="flex-row gap-3">
          <StatTileSkeleton />
          <StatTileSkeleton />
        </View>
        <View className="flex-row gap-3">
          <StatTileSkeleton />
          <StatTileSkeleton />
        </View>
      </Animated.View>
    );
  } else if (data) {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="gap-3">
        <View className="flex-row gap-3">
          <StatTile
            label={t('organization.usageStats.cost')}
            value={formatMoney(fromMicrodollars(data.totalCost), i18n.language)}
          />
          <StatTile
            label={t('organization.usageStats.requests')}
            value={formatNumber(data.totalRequestCount, i18n.language)}
          />
        </View>
        <View className="flex-row gap-3">
          <StatTile
            label={t('organization.usageStats.inputTokens')}
            value={formatNumber(data.totalInputTokens, i18n.language)}
          />
          <StatTile
            label={t('organization.usageStats.outputTokens')}
            value={formatNumber(data.totalOutputTokens, i18n.language)}
          />
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('organization.usageStats.last30Days')}
      </Text>
      {body}
    </Animated.View>
  );
}
