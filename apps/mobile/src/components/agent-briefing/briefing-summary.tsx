import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { briefingMoney } from '@/lib/agent-briefing-format';
import { briefingSummaryStatusKey } from '@/lib/agent-briefing-state';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { resolveCatalogModelName } from '@/lib/model-display-name';

export function BriefingSummary({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const catalog = useAvailableModels(report.context.organizationId ?? undefined);
  const cost = briefingMoney(report.summary.costMicrodollars, i18n.language);
  return (
    <Card>
      <Text variant="heading">{t('agentBriefing.summary')}</Text>
      {report.summary.status !== 'ready' ? (
        <Text variant="muted">{t(briefingSummaryStatusKey(report.summary.status))}</Text>
      ) : null}
      {report.summary.text ? <Text selectable>{report.summary.text}</Text> : null}
      {report.summary.model ? (
        <Text variant="caption">
          {t('common.model')}: {resolveCatalogModelName(report.summary.model, catalog.models)}
        </Text>
      ) : null}
      {report.summary.costMicrodollars > 0 ||
      (report.summary.chargeStatus === 'pending' && report.summary.startedAt !== null) ? (
        <Text variant="caption">
          {report.summary.chargeStatus === 'settled'
            ? t('agentBriefing.summaryCharge', { cost })
            : t('agentBriefing.summaryChargePending')}
        </Text>
      ) : null}
    </Card>
  );
}
