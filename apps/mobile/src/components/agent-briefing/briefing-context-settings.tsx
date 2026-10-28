import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';

import { ModelSelector } from '@/components/agents/model-selector';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type BriefingPreferences } from '@/lib/agent-briefing';
import { briefingMoney } from '@/lib/agent-briefing-format';
import {
  briefingEstimateUnavailableKey,
  parseBriefingSafeguardInput,
} from '@/lib/agent-briefing-state';
import { formatNumber } from '@/lib/format';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

type ContextPreference = BriefingPreferences['contexts'][number];

/**
 * Six decimals cover a whole second (1/60 min) and a single microdollar. No
 * grouping, so the value the field shows parses back without an ambiguous
 * group separator.
 */
const SAFEGUARD_INPUT_FORMAT: Intl.NumberFormatOptions = {
  maximumFractionDigits: 6,
  useGrouping: false,
};

export function BriefingContextSettings({
  preference,
  defaultModel,
  timezone,
}: {
  readonly preference: ContextPreference;
  readonly defaultModel: string;
  readonly timezone: string;
}) {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const client = useQueryClient();
  const offline = useOfflineBannerState();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const organizationId = preference.context.organizationId ?? undefined;
  const catalog = useAvailableModels(organizationId);
  const [model, setModel] = useState(preference.model);
  const duration = useRef(
    formatNumber(preference.maxDurationSeconds / 60, locale, SAFEGUARD_INPUT_FORMAT)
  );
  const spend = useRef(
    formatNumber(preference.maxSpendMicrodollars / 1_000_000, locale, SAFEGUARD_INPUT_FORMAT)
  );
  const [limits, setLimits] = useState({
    maxDurationSeconds: preference.maxDurationSeconds,
    maxSpendMicrodollars: preference.maxSpendMicrodollars,
  });
  const [valid, setValid] = useState(true);
  const contextName =
    preference.context.organizationId === null ? t('common.personal') : preference.context.name;
  const estimate = useQuery({
    ...trpc.agentBriefing.estimateSummary.queryOptions({
      organizationId,
      model,
      maxDurationSeconds: limits.maxDurationSeconds,
      maxSpendMicrodollars: limits.maxSpendMicrodollars,
    }),
    enabled: !offline && valid,
    staleTime: 0,
  });
  const update = useMutation(
    trpc.agentBriefing.updateContextPreferences.mutationOptions({
      onMutate: async input => {
        await client.cancelQueries({ queryKey: trpc.agentBriefing.preferences.pathKey() });
        const previous = client.getQueriesData<BriefingPreferences>({
          queryKey: trpc.agentBriefing.preferences.pathKey(),
        });
        client.setQueriesData<BriefingPreferences>(
          { queryKey: trpc.agentBriefing.preferences.pathKey() },
          data =>
            data
              ? {
                  ...data,
                  contexts: data.contexts.map(item =>
                    item.context.id === preference.context.id
                      ? {
                          ...item,
                          enabled: input.enabled,
                          model: input.model ?? item.model,
                          maxDurationSeconds: input.maxDurationSeconds ?? item.maxDurationSeconds,
                          maxSpendMicrodollars:
                            input.maxSpendMicrodollars ?? item.maxSpendMicrodollars,
                        }
                      : item
                  ),
                }
              : data
        );
        return { previous };
      },
      onSuccess: () => {
        announcingToast.success(t('agentBriefing.saved'));
      },
      onError: (_error, _input, context) => {
        for (const [key, value] of context?.previous ?? []) {
          client.setQueryData(key, value);
        }
        toast.error(t('common.couldNotSaveSetting'));
      },
      onSettled: () => {
        void client.invalidateQueries({ queryKey: trpc.agentBriefing.preferences.pathKey() });
      },
    })
  );
  const updateLimits = () => {
    const next = parseBriefingSafeguardInput(duration.current, spend.current, locale);
    setValid(next !== null);
    if (next !== null) {
      setLimits(next);
    }
  };
  const enable = async () => {
    if (!valid) {
      toast.error(t('agentBriefing.invalidSafeguards'));
      return;
    }
    const result = await estimate.refetch();
    const quote = result.data;
    if (!quote?.canGenerate) {
      toast.error(t(briefingEstimateUnavailableKey(quote?.unavailableReason)));
      return;
    }
    Alert.alert(
      t('agentBriefing.confirmPaid', { context: contextName }),
      t('agentBriefing.paidDisclosure', {
        estimate: briefingMoney(quote.estimatedCostMicrodollars, i18n.language),
        maximum: briefingMoney(quote.maximumCostMicrodollars, i18n.language),
        minutes: quote.maxDurationSeconds / 60,
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('agentBriefing.enable'),
          onPress: () => {
            update.mutate({
              organizationId,
              enabled: true,
              timezone,
              language: locale,
              model,
              ...limits,
              estimateToken: quote.estimateToken,
            });
          },
        },
      ]
    );
  };
  return (
    <View className="gap-4 rounded-2xl border border-border bg-card p-4">
      <Text className="font-semibold">
        {t('agentBriefing.scheduledContextSettings', { context: contextName })}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('agentBriefing.scheduledContextHint')}
      </Text>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm">{t('agentBriefing.scheduledContextEnabled')}</Text>
        <Switch
          value={preference.enabled}
          disabled={offline || update.isPending}
          accessibilityLabel={t('agentBriefing.scheduledContextEnabled')}
          accessibilityState={{
            checked: preference.enabled,
            disabled: offline || update.isPending,
          }}
          onValueChange={next => {
            if (next) {
              void enable();
            } else {
              update.mutate({ organizationId, enabled: false, timezone, language: locale });
            }
          }}
        />
      </View>
      <ModelSelector
        value={model}
        variant=""
        options={catalog.models}
        isLoading={catalog.isLoading}
        disabled={offline || update.isPending}
        onSelect={id => {
          setModel(id);
        }}
      />
      {catalog.isError ? (
        <Button
          variant="ghost"
          onPress={() => {
            void catalog.refetch();
          }}
        >
          <Text>{t('common.couldNotLoadModels')}</Text>
        </Button>
      ) : null}
      {model === defaultModel ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={offline || update.isPending}
          onPress={() => {
            setModel(defaultModel);
          }}
        >
          <Text>{t('agentBriefing.defaultModel')}</Text>
        </Button>
      )}
      <View className="gap-2">
        <FormField
          label={t('agentBriefing.duration')}
          defaultValue={duration.current}
          keyboardType="decimal-pad"
          onChangeText={value => {
            duration.current = value;
            updateLimits();
          }}
        />
        <FormField
          label={t('agentBriefing.spendLimit')}
          defaultValue={spend.current}
          keyboardType="decimal-pad"
          onChangeText={value => {
            spend.current = value;
            updateLimits();
          }}
        />
        <Text className="text-xs text-muted-foreground">
          {t('agentBriefing.snapshotSafeguards')}
        </Text>
        {!valid ? (
          <Text className="text-sm text-destructive">{t('agentBriefing.invalidSafeguards')}</Text>
        ) : null}
      </View>
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
          size="sm"
          onPress={() => {
            void estimate.refetch();
          }}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
      <Button
        variant="outline"
        disabled={
          offline ||
          !valid ||
          update.isPending ||
          !estimate.data?.canGenerate ||
          estimate.isFetching
        }
        onPress={() => {
          void enable();
        }}
      >
        <Text>{t(preference.enabled ? 'common.save' : 'agentBriefing.enable')}</Text>
      </Button>
    </View>
  );
}
