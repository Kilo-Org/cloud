import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { useBriefingLocale } from './briefing-locale';
import { formatBriefingTimestamp } from './briefing-window';

export function BriefingPeriodLabel({ report }: { readonly report: BriefingReport }) {
  const { t } = useTranslation();
  const locale = useBriefingLocale();
  // All three instants are formatted in one zone, so the nightly window's own
  // result names the zone the caption prints: a report zone the runtime refused
  // was formatted in the device zone, and the caption must say so.
  const nightStart = formatBriefingTimestamp(report.nightStartAt, locale, report.timezone);
  const cutoff = formatBriefingTimestamp(report.cutoffAt, locale, report.timezone);
  return (
    <View className="gap-1">
      {/* The zone sits on the date line, after the window: on its own line it
          read as a third timestamp, and under a long range it wrapped there on
          its own. The range gives up width first and ellipsizes; the zone keeps
          its own width. */}
      <View className="flex-row items-center gap-1">
        <Text variant="caption" className="shrink" numberOfLines={1}>
          {t('common.timeRange', { start: nightStart.text, end: cutoff.text })}
        </Text>
        <Text variant="caption" className="shrink-0">
          {nightStart.timeZone}
        </Text>
      </View>
      <Text variant="caption">
        {t('agentBriefing.capturedAt', {
          time: formatBriefingTimestamp(report.capturedAt, locale, report.timezone).text,
        })}
      </Text>
    </View>
  );
}
