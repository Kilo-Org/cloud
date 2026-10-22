import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';

import { briefingMoney } from './briefing-card';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type BriefingReport, useBriefingPreferences } from '@/lib/agent-briefing';
import {
  briefingEstimateUnavailableKey,
  briefingSummaryStatusKey,
} from '@/lib/agent-briefing-state';
import {
  getCommittedConnectivityStatus,
  useOfflineBannerState,
} from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

export function BriefingSummary({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const client = useQueryClient();
  const offline = useOfflineBannerState();
  const preferences = useBriefingPreferences(report.kind === 'one_off');
  const context = preferences.data?.contexts.find(item => item.context.id === report.context.id);
  const canRequest =
    Boolean(context && (report.kind === 'one_off' || context.aiEnabled)) &&
    (report.summary.canRetry || report.summary.status === 'disabled');
  const confirming = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reviewKey = JSON.stringify([
    report.id,
    report.revision,
    report.summary.status,
    report.summary.costMicrodollars,
    context?.model,
    context?.maxDurationSeconds,
    context?.maxSpendMicrodollars,
    canRequest,
  ]);
  const currentReviewKey = useRef(reviewKey);
  currentReviewKey.current = reviewKey;
  const estimate = useQuery({
    ...trpc.agentBriefing.estimateSummary.queryOptions({
      organizationId: report.context.organizationId ?? undefined,
      reportId: report.id,
      model: context?.model,
      maxDurationSeconds: context?.maxDurationSeconds,
      maxSpendMicrodollars: context?.maxSpendMicrodollars,
    }),
    enabled: canRequest && !offline,
    staleTime: 0,
  });
  const onSuccess = () => {
    void client.invalidateQueries({ queryKey: trpc.agentBriefing.pathKey() });
  };
  const onError = (error: { message: string }) => {
    toast.error(error.message);
  };
  const generate = useMutation(
    trpc.agentBriefing.generateSummary.mutationOptions({
      onSuccess,
      onError,
      networkMode: 'always',
      retry: false,
    })
  );
  const retry = useMutation(
    trpc.agentBriefing.retrySummary.mutationOptions({
      onSuccess,
      onError,
      networkMode: 'always',
      retry: false,
    })
  );
  const cost = briefingMoney(report.summary.costMicrodollars, i18n.language);

  const confirm = async () => {
    if (confirming.current || offline || getCommittedConnectivityStatus() === 'offline') {
      return;
    }
    confirming.current = true;
    setConfirmOpen(true);
    const release = () => {
      confirming.current = false;
      setConfirmOpen(false);
    };
    const result = await estimate.refetch();
    const quote = result.data;
    if (result.isError || !quote?.canGenerate || currentReviewKey.current !== reviewKey) {
      release();
      toast.error(t(briefingEstimateUnavailableKey(quote?.unavailableReason)));
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
        { text: t('common.cancel'), style: 'cancel', onPress: release },
        {
          text: t(
            report.summary.canRetry ? 'agentBriefing.retrySummary' : 'agentBriefing.generate'
          ),
          onPress: () => {
            release();
            if (
              currentReviewKey.current !== reviewKey ||
              getCommittedConnectivityStatus() === 'offline'
            ) {
              return;
            }
            const input = { reportId: report.id, estimateToken: quote.estimateToken };
            if (report.summary.canRetry) {
              retry.mutate(input);
            } else {
              generate.mutate(input);
            }
          },
        },
      ],
      { cancelable: true, onDismiss: release }
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
      {report.summary.costMicrodollars > 0 ||
      (report.summary.chargeStatus === 'pending' && report.summary.startedAt !== null) ? (
        <Text className="text-xs text-muted-foreground">
          {report.summary.chargeStatus === 'settled'
            ? t('agentBriefing.summaryCharge', { cost })
            : t('agentBriefing.summaryChargePending')}
        </Text>
      ) : null}
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
              {t(briefingEstimateUnavailableKey(estimate.data?.unavailableReason))}
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
            disabled={offline || confirmOpen || !estimate.data?.canGenerate || estimate.isFetching}
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
