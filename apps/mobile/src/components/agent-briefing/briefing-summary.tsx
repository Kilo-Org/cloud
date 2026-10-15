import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';

import { briefingMoney } from './briefing-card';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type BriefingReport, useBriefingPreferences } from '@/lib/agent-briefing';
import { briefingSummaryStatusKey } from '@/lib/agent-briefing-state';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

export function BriefingSummary({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const client = useQueryClient();
  const offline = useOfflineBannerState();
  const preferences = useBriefingPreferences();
  const context = preferences.data?.contexts.find(item => item.context.id === report.context.id);
  const canRequest =
    context?.aiEnabled && (report.summary.canRetry || report.summary.status === 'disabled');
  const estimate = useQuery({
    ...trpc.agentBriefing.estimateSummary.queryOptions({
      organizationId: report.context.organizationId ?? undefined,
      reportId: report.id,
      model: context?.model,
      maxDurationSeconds: context?.maxDurationSeconds,
      maxSpendMicrodollars: context?.maxSpendMicrodollars,
    }),
    enabled: Boolean(canRequest) && !offline,
    staleTime: 0,
  });
  const onSuccess = () => {
    void client.invalidateQueries({ queryKey: trpc.agentBriefing.pathKey() });
  };
  const onError = () => {
    toast.error(t('agentBriefing.summaryFailed'));
  };
  const generate = useMutation(
    trpc.agentBriefing.generateSummary.mutationOptions({ onSuccess, onError })
  );
  const retry = useMutation(
    trpc.agentBriefing.retrySummary.mutationOptions({ onSuccess, onError })
  );
  const cost = briefingMoney(report.summary.costMicrodollars, i18n.language);

  const confirm = async () => {
    const result = await estimate.refetch();
    const quote = result.data;
    if (!quote?.canGenerate) {
      toast.error(t('agentBriefing.estimateUnavailable'));
      return;
    }
    Alert.alert(
      t('agentBriefing.confirmGeneration'),
      t('agentBriefing.paidDisclosure', {
        estimate: briefingMoney(quote.estimatedCostMicrodollars, i18n.language),
        maximum: briefingMoney(quote.maximumCostMicrodollars, i18n.language),
        minutes: quote.maxDurationSeconds / 60,
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t(
            report.summary.canRetry ? 'agentBriefing.retrySummary' : 'agentBriefing.generate'
          ),
          onPress: () => {
            const input = { reportId: report.id, estimateToken: quote.estimateToken };
            if (report.summary.canRetry) {
              retry.mutate(input);
            } else {
              generate.mutate(input);
            }
          },
        },
      ]
    );
  };

  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Text className="font-semibold">{t('agentBriefing.summary')}</Text>
      {report.summary.status !== 'ready' ? (
        <Text className="text-sm text-muted-foreground">
          {t(briefingSummaryStatusKey(report.summary.status))}
        </Text>
      ) : null}
      {report.summary.text ? (
        <Text className="text-sm leading-6" selectable>
          {report.summary.text}
        </Text>
      ) : null}
      {report.summary.model ? (
        <Text className="text-xs text-muted-foreground">{report.summary.model}</Text>
      ) : null}
      <Text className="text-xs text-muted-foreground">
        {report.summary.chargeStatus === 'settled'
          ? t('agentBriefing.summaryCharge', { cost })
          : t('agentBriefing.summaryChargePending')}
      </Text>
      {canRequest ? (
        <View className="gap-2">
          {estimate.data?.canGenerate ? (
            <Text className="text-xs text-muted-foreground">
              {t('agentBriefing.estimate', {
                estimate: briefingMoney(estimate.data.estimatedCostMicrodollars, i18n.language),
                maximum: briefingMoney(estimate.data.maximumCostMicrodollars, i18n.language),
              })}
            </Text>
          ) : (
            <Text className="text-xs text-muted-foreground">
              {t('agentBriefing.estimateUnavailable')}
            </Text>
          )}
          {estimate.isError ? (
            <Button
              variant="ghost"
              onPress={() => {
                void estimate.refetch();
              }}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={offline || !estimate.data?.canGenerate || estimate.isFetching}
            loading={generate.isPending || retry.isPending}
            onPress={() => {
              void confirm();
            }}
          >
            <Text>
              {t(report.summary.canRetry ? 'agentBriefing.retrySummary' : 'agentBriefing.generate')}
            </Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
