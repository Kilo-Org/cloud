import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { BriefingScorecard } from './briefing-card';
import { BriefingPeriodLabel } from './briefing-period-label';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { briefingMoney } from '@/lib/agent-briefing-format';
import { briefingEstimateUnavailableKey } from '@/lib/agent-briefing-state';
import { type PreparedBriefing } from '@/lib/hooks/use-create-briefing';

export function BriefingCreateReview({
  prepared,
  disabled,
  creating,
  onCreate,
  onReviewAgain,
}: {
  readonly prepared: PreparedBriefing;
  readonly disabled: boolean;
  readonly creating: boolean;
  readonly onCreate: () => void;
  readonly onReviewAgain: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { report, estimate } = prepared;
  const contextName =
    report.context.organizationId === null ? t('common.personal') : report.context.name;
  return (
    <View className="gap-4 rounded-2xl border border-border bg-card p-4">
      <Text className="text-lg font-semibold">{t('agentBriefing.reviewBriefing')}</Text>
      <Text>{contextName}</Text>
      <BriefingPeriodLabel report={report} />
      <BriefingScorecard report={report} />
      {Object.values(report.coverage).some(value => value !== 'complete') ? (
        <Text className="text-sm text-muted-foreground">{t('agentBriefing.coverageHint')}</Text>
      ) : null}
      <Text className="text-xs text-muted-foreground">
        {t('agentBriefing.historicalStateHint')}
      </Text>
      {estimate === null ? (
        <Text className="text-sm">{t('agentBriefing.emptyPeriod')}</Text>
      ) : (
        <View className="gap-2">
          <Text className="font-semibold">{t('agentBriefing.summary')}</Text>
          <Text className="text-sm">{t('agentBriefing.payer', { context: contextName })}</Text>
          <Text className="text-sm">
            {t('common.model')}: {estimate.model}
          </Text>
          {estimate.canGenerate ? (
            <Text className="text-sm">
              {t('agentBriefing.paidDisclosure', {
                estimate: briefingMoney(estimate.estimatedCostMicrodollars, i18n.language),
                maximum: briefingMoney(estimate.maximumCostMicrodollars, i18n.language),
                minutes: estimate.maxDurationSeconds / 60,
              })}
            </Text>
          ) : (
            <Text className="text-sm text-destructive">
              {t(briefingEstimateUnavailableKey(estimate.unavailableReason))}
            </Text>
          )}
        </View>
      )}
      {estimate !== null ? (
        <Text className="text-xs text-muted-foreground">{t('agentBriefing.oneOffHint')}</Text>
      ) : null}
      <Button
        disabled={disabled || (estimate !== null && !estimate.canGenerate)}
        loading={creating}
        onPress={onCreate}
      >
        <Text>{t('agentBriefing.create')}</Text>
      </Button>
      <Button variant="ghost" disabled={disabled || creating} onPress={onReviewAgain}>
        <Text>{t('agentBriefing.reviewAgain')}</Text>
      </Button>
    </View>
  );
}
