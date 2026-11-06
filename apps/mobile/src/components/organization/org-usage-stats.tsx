import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatMoney, formatNumber } from '@/lib/format';
import { useOrgUsageStats } from '@/lib/hooks/use-organization-queries';

/**
 * One stat card. The value slot keeps its height when the number resolves —
 * `text-lg` measures 24.8 dp and the loading block is 24 dp — so the label
 * under it cannot move when the query answers.
 */
function StatTile({ label, value }: Readonly<{ label: string; value: string | null }>) {
  return (
    <View className="flex-1 gap-1 rounded-lg bg-secondary px-3 py-3">
      {value === null ? (
        // `bg-muted-soft`, not the default `bg-skeleton-fill`: in light mode the
        // placeholder fill equals the card's own `bg-secondary`, so a default
        // skeleton paints nothing. The hub's low-balance subtitle reserves its
        // line the same way.
        <Skeleton className="h-7 w-16 rounded-md bg-muted-soft" />
      ) : (
        <Text className="text-lg font-bold text-foreground">{value}</Text>
      )}
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

type OrgUsageStatsProps = {
  organizationId: string;
};

/**
 * "Last 30 days" eyebrow + 2x2 usage stat tile grid. Visible to all org roles.
 *
 * The grid carries no entrance animation: it is the section's entire body, so a
 * fade that does not run leaves four cards unpainted while their frames and
 * accessibility nodes are already in place.
 */
export function OrgUsageStats({ organizationId }: Readonly<OrgUsageStatsProps>) {
  const { t } = useTranslation();
  const { data, isError, isPaused, isFetching, refetch } = useOrgUsageStats(organizationId);
  const unavailable = data == null && (isError || isPaused);
  // A tile with no totals yet shows a loading block while the first request is
  // outstanding, the dash when the section cannot load at all, and the cached
  // totals through a refetch error.
  const missingValue = unavailable ? '—' : null;

  return (
    <View className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('organization.usageStats.last30Days')}
      </Text>
      <View className="gap-3">
        <View className="flex-row gap-3">
          <StatTile
            label={t('common.cost')}
            value={
              data ? formatMoney(fromMicrodollars(data.totalCost), i18n.language) : missingValue
            }
          />
          <StatTile
            label={t('organization.usageStats.requests')}
            value={data ? formatNumber(data.totalRequestCount, i18n.language) : missingValue}
          />
        </View>
        <View className="flex-row gap-3">
          <StatTile
            label={t('organization.usageStats.inputTokens')}
            value={data ? formatNumber(data.totalInputTokens, i18n.language) : missingValue}
          />
          <StatTile
            label={t('organization.usageStats.outputTokens')}
            value={data ? formatNumber(data.totalOutputTokens, i18n.language) : missingValue}
          />
        </View>
      </View>
      {unavailable && (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
            {t(isPaused ? 'queryError.offlineTitle' : 'common.somethingWentWrong')}
          </Text>
          <Button variant="outline" loading={isFetching} onPress={() => void refetch()}>
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
