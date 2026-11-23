import { useTranslation } from 'react-i18next';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { briefingMoney } from '@/lib/agent-briefing-format';
import { briefingSummaryBodyKey } from '@/lib/agent-briefing-state';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { resolveCatalogModelName } from '@/lib/model-display-name';
import { useBriefingLocale } from './briefing-locale';

export function BriefingSummary({ report }: { readonly report: BriefingReport }) {
  const { t } = useTranslation();
  const locale = useBriefingLocale();
  const catalog = useAvailableModels(report.context.organizationId ?? undefined);
  const cost = briefingMoney(report.summary.costMicrodollars, locale);
  return (
    <Card>
      <Text variant="heading">{t('agentBriefing.summary')}</Text>
      {report.summary.status !== 'ready' ? (
        <Text variant="muted">
          {t(briefingSummaryBodyKey(report.summary.status, report.summary.error))}
        </Text>
      ) : null}
      {report.summary.text ? <Text selectable>{report.summary.text}</Text> : null}
      {report.summary.model ? (
        <Text variant="caption">
          {t('agentBriefing.summaryModel', {
            model: resolveCatalogModelName(report.summary.model, catalog.models),
          })}
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
