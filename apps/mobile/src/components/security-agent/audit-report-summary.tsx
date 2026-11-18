import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  SEVERITY_LABEL_KEYS,
  SEVERITY_ORDER,
  summaryCountLabel,
  type SummaryFigureKind,
} from '@/components/security-agent/audit-report-copy';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

type ReportSummaryFigures = {
  findingCount: number;
  activityCount: number;
  bySeverity: Record<(typeof SEVERITY_ORDER)[number], number>;
};

function SummaryCount({
  kind,
  label,
  value,
}: Readonly<{ kind: SummaryFigureKind; label: string; value: number }>) {
  const displayCount = formatNumber(value, i18n.language);
  return (
    // One element per figure: a screen reader hears each count with the label
    // it counts, never a run of bare numbers.
    <View
      className="min-w-16"
      accessible
      accessibilityLabel={summaryCountLabel({ kind, value, displayCount, label })}
    >
      <Text className="text-lg font-semibold tabular-nums">{displayCount}</Text>
      <Text variant="muted" className="text-xs">
        {label}
      </Text>
    </View>
  );
}

export function ReportSummary({ summary }: Readonly<{ summary: ReportSummaryFigures }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 rounded-lg bg-secondary p-3">
      <Text className="text-sm font-medium">{t('securityAgent.auditReport.summary')}</Text>
      <View className="flex-row flex-wrap gap-x-6 gap-y-2">
        <SummaryCount kind="findings" label={t('common.findings')} value={summary.findingCount} />
        <SummaryCount
          kind="events"
          label={t('securityAgent.auditReport.events')}
          value={summary.activityCount}
        />
        {SEVERITY_ORDER.map(severity => (
          <SummaryCount
            key={severity}
            kind="severity"
            label={t(SEVERITY_LABEL_KEYS[severity])}
            value={summary.bySeverity[severity]}
          />
        ))}
      </View>
    </View>
  );
}
