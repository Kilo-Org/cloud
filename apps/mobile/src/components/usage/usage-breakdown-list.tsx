import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { formatPercent } from '@/lib/format';

import { formatUsageCost, humanizeDimension } from './usage-format';

type UsageBreakdownEntry = {
  key: string;
  label: string;
  value: number;
  percentage: number;
};

type UsageBreakdownListProps = {
  title: string;
  entries: readonly UsageBreakdownEntry[];
  /** Cost keys are microdollars, the same unit the summary reports. */
};

/**
 * The cost leaders for one dimension. Each row names the model or feature, its
 * cost and its share of the returned rows — the same three facts web's
 * breakdown columns carry.
 */
export function UsageBreakdownList({ title, entries }: Readonly<UsageBreakdownListProps>) {
  const { i18n } = useTranslation();
  if (entries.length === 0) {
    return null;
  }

  return (
    <View className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {title}
      </Text>
      <View className="rounded-lg bg-secondary px-3">
        {entries.map((entry, index) => (
          <View
            key={entry.key}
            className={
              index === entries.length - 1
                ? 'flex-row items-center justify-between gap-3 py-3'
                : 'flex-row items-center justify-between gap-3 border-b-[0.5px] border-hair-soft py-3'
            }
          >
            <Text className="min-w-0 shrink text-sm text-foreground" numberOfLines={1}>
              {humanizeDimension(entry.label)}
            </Text>
            <View className="shrink-0 flex-row items-center gap-2">
              <Text className="text-sm text-foreground tabular-nums">
                {formatUsageCost(entry.value, i18n.language)}
              </Text>
              <Text className="w-10 text-right text-xs text-muted-foreground tabular-nums">
                {formatPercent(entry.percentage, i18n.language)}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
