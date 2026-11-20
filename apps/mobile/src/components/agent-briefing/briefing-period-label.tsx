import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { formatBriefingTimestamp } from './briefing-window';

export function BriefingPeriodLabel({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  return (
    <View className="gap-1">
      {/* The zone sits on the date line, after the window: on its own line it
          read as a third timestamp, and under a long range it wrapped there on
          its own. The range gives up width first and ellipsizes; the zone keeps
          its own width. */}
      <View className="flex-row items-center gap-1">
        <Text variant="caption" className="shrink" numberOfLines={1}>
          {t('common.timeRange', {
            start: formatBriefingTimestamp(report.nightStartAt, i18n.language, report.timezone),
            end: formatBriefingTimestamp(report.cutoffAt, i18n.language, report.timezone),
          })}
        </Text>
        <Text variant="caption" className="shrink-0">
          {report.timezone}
        </Text>
      </View>
      <Text variant="caption">
        {t('agentBriefing.capturedAt', {
          time: formatBriefingTimestamp(report.capturedAt, i18n.language, report.timezone),
        })}
      </Text>
    </View>
  );
}
