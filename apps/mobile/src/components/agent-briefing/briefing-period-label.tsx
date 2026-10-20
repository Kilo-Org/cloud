import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

export function BriefingPeriodLabel({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: report.timezone,
  };
  return (
    <View className="gap-1">
      {report.kind === 'one_off' ? (
        <Text className="text-sm text-muted-foreground">{t('agentBriefing.oneOff')}</Text>
      ) : (
        <Text className="text-sm text-muted-foreground">{report.localDate}</Text>
      )}
      <Text className="text-xs text-muted-foreground">
        {t('agentBriefing.window', {
          start: formatDate(parseTimestamp(report.nightStartAt), i18n.language, options),
          end: formatDate(parseTimestamp(report.cutoffAt), i18n.language, options),
        })}
      </Text>
      <Text className="text-xs text-muted-foreground">{report.timezone}</Text>
      {report.kind === 'one_off' ? (
        <Text className="text-xs text-muted-foreground">
          {t('agentBriefing.createdAt', {
            time: formatDate(parseTimestamp(report.createdAt), i18n.language, options),
          })}
        </Text>
      ) : null}
    </View>
  );
}
