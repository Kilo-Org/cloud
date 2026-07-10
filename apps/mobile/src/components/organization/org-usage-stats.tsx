import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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
  const { data, isLoading } = useOrgUsageStats(organizationId);

  return (
    <Animated.View layout={LinearTransition} className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        Last 30 days
      </Text>
      {isLoading || !data ? (
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
      ) : (
        <Animated.View entering={FadeIn.duration(200)} className="gap-3">
          <View className="flex-row gap-3">
            <StatTile label="Cost" value={`$${fromMicrodollars(data.totalCost).toFixed(2)}`} />
            <StatTile label="Requests" value={data.totalRequestCount.toLocaleString()} />
          </View>
          <View className="flex-row gap-3">
            <StatTile label="Input Tokens" value={data.totalInputTokens.toLocaleString()} />
            <StatTile label="Output Tokens" value={data.totalOutputTokens.toLocaleString()} />
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}
