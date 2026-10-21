import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
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

type OrgUsageStatsProps = {
  organizationId: string;
};

/** The server's `organizations.usageStats` window, which the eyebrow names. */
const USAGE_WINDOW_DAYS = 30;

/** "Last 30 days" eyebrow + 2x2 usage stat tile grid. Visible to all org roles. */
export function OrgUsageStats({ organizationId }: Readonly<OrgUsageStatsProps>) {
  const { t } = useTranslation();
  const { data, isError, isPaused, isFetching, refetch } = useOrgUsageStats(organizationId);
  const unavailable = data == null && (isError || isPaused);

  const body = (
    <Animated.View entering={FadeIn.duration(200)} className="gap-3">
      <View className="flex-row gap-3">
        <StatTile
          label={t('common.cost')}
          value={data ? formatMoney(fromMicrodollars(data.totalCost), i18n.language) : '—'}
        />
        <StatTile
          label={t('organization.usageStats.requests')}
          value={data ? formatNumber(data.totalRequestCount, i18n.language) : '—'}
        />
      </View>
      <View className="flex-row gap-3">
        <StatTile
          label={t('organization.usageStats.inputTokens')}
          value={data ? formatNumber(data.totalInputTokens, i18n.language) : '—'}
        />
        <StatTile
          label={t('organization.usageStats.outputTokens')}
          value={data ? formatNumber(data.totalOutputTokens, i18n.language) : '—'}
        />
      </View>
    </Animated.View>
  );

  return (
    <Animated.View layout={LinearTransition} className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('organization.usageStats.last30Days', {
          days: formatNumber(USAGE_WINDOW_DAYS, i18n.language),
        })}
      </Text>
      {body}
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
    </Animated.View>
  );
}
