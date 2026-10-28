import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { formatCalendarDate } from '@/lib/format';
import { formatBriefingTimestamp } from './briefing-window';

export function BriefingPeriodLabel({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  return (
    <View className="gap-1">
      <Text className="text-sm text-muted-foreground">
        {formatCalendarDate(report.localDate, i18n.language)}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t('agentBriefing.window', {
          start: formatBriefingTimestamp(report.nightStartAt, i18n.language, report.timezone),
          end: formatBriefingTimestamp(report.cutoffAt, i18n.language, report.timezone),
        })}
      </Text>
      <Text className="text-xs text-muted-foreground">{report.timezone}</Text>
      <Text className="text-xs text-muted-foreground">
        {t('agentBriefing.capturedAt', {
          time: formatBriefingTimestamp(report.capturedAt, i18n.language, report.timezone),
        })}
      </Text>
    </View>
  );
}
