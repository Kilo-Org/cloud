import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';

import { ModelSelector } from '@/components/agents/model-selector';
import {
  BriefingEstimateLine,
  type BriefingEstimateLineQuote,
  parseBriefingEstimateLineQuote,
} from '@/components/agent-briefing/briefing-estimate-line';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type BriefingPreferences } from '@/lib/agent-briefing';
import { briefingMoney } from '@/lib/agent-briefing-format';
import {
  briefingEstimateUnavailableKey,
  parseBriefingSafeguardInput,
} from '@/lib/agent-briefing-state';
import { formatNumber } from '@/lib/format';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { type SurfaceAttempt } from '@/lib/surface-feedback';
import { useTRPC } from '@/lib/trpc';

type ContextPreference = BriefingPreferences['contexts'][number];

/**
 * The enable flow reports every outcome as a toast or the platform dialog, so
 * its surface never holds a failure: the type exists only to instantiate the
 * store whose pending phase is the admission guard.
 */
type EnableSurfaceFailure = { readonly kind: 'reported-as-a-toast' };

/**
 * Six decimals cover a whole second (1/60 min) and a single microdollar. No
 * grouping, so the value the field shows parses back without an ambiguous
 * group separator.
 */
const SAFEGUARD_INPUT_FORMAT: Intl.NumberFormatOptions = {
  maximumFractionDigits: 6,
  useGrouping: false,
};

/**
 * A disclosure names the limit to the nearest hundredth of a minute, so a
 * duration that is not a whole number of minutes reads as `0.13`, not as the
 * full quotient. Locale formatting supplies the decimal separator.
 */
const SAFEGUARD_DISCLOSURE_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 2 };

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
  const { feedback: enabling, begin: beginEnable } = useSurfaceFeedback<EnableSurfaceFailure>();
  // One admission guard covers the switch and the primary button: both start the
  // same confirm-and-enable flow, so a tap on either while one runs does nothing.
  const enablingEnabled = enabling.status === 'pending';
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
  // One phase per state of the quote line, so no flag pair can render two lines
  // or the wrong one. An unparsable field disables the query, so the last
  // estimate cannot speak for the current limits and `invalid` owns the line.
  // With no quote yet the line is `estimating`: a paused (offline) or failed
  // read has produced nothing to describe, and the retry button below owns
  // recovery, so "cannot quote" copy never claims a quote that does not exist.
  const quote = estimate.data;
  const limitQuote: BriefingEstimateLineQuote = parseBriefingEstimateLineQuote(valid, quote);
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
  /**
   * The whole enable flow behind one admitted attempt. The toast and Alert
   * outcomes are the copy this flow owns, so nothing persists on the surface:
   * every exit settles with `abandon()`, and a second tap is refused by the
   * attempt that is still running.
   */
  const runEnable = async (attempt: SurfaceAttempt<EnableSurfaceFailure>): Promise<void> => {
    try {
      if (!valid) {
        toast.error(t('agentBriefing.invalidSafeguards'));
        return;
      }
      const result = await estimate.refetch();
      const confirmed = result.data;
      if (!confirmed?.canGenerate) {
        toast.error(t(briefingEstimateUnavailableKey(confirmed?.unavailableReason)));
        return;
      }
      Alert.alert(
        t('agentBriefing.confirmPaid', { context: contextName }),
        t('agentBriefing.paidDisclosure', {
          estimate: briefingMoney(confirmed.estimatedCostMicrodollars, i18n.language),
          maximum: briefingMoney(confirmed.maximumCostMicrodollars, i18n.language),
          minutes: formatNumber(
            confirmed.maxDurationSeconds / 60,
            locale,
            SAFEGUARD_DISCLOSURE_FORMAT
          ),
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
                estimateToken: confirmed.estimateToken,
              });
            },
          },
        ],
        // Android back dismisses, which equals Cancel: nothing is enabled.
        { cancelable: true }
      );
    } finally {
      attempt.abandon();
    }
  };
  /** Admission before the first await; a tap while one is running does nothing. */
  const startEnable = (): void => {
    const attempt = beginEnable();
    if (attempt === null) {
      return;
    }
    void runEnable(attempt);
  };
  // The estimate's first load is a wait this card owns: the primary action shows
  // the same spinner the switch does while the quote is on its way.
  const estimateLoading =
    estimate.data === undefined && (estimate.isPending || estimate.isFetching);
  /** Exactly one line per quote phase, rendered by the line's own component. */
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
          disabled={offline || update.isPending || enablingEnabled}
          accessibilityLabel={t('agentBriefing.scheduledContextEnabled')}
          accessibilityState={{
            checked: preference.enabled,
            disabled: offline || update.isPending || enablingEnabled,
            // Both paths are busy while a quote is in flight: the estimate's own
            // fetch, and the confirm-and-enable flow that refetches it.
            busy: enablingEnabled || estimate.isFetching,
          }}
          onValueChange={next => {
            if (next) {
              startEnable();
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
        // The brief's context stores a model slug only, so the picker must not
        // offer a thinking effort it would have to drop.
        acceptsVariant={false}
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
      </View>
      <BriefingEstimateLine quote={limitQuote} />
      {estimate.isError ? (
        <Button
          variant="ghost"
          size="sm"
          className={STATE_ACTION_CLASS}
          onPress={() => {
            void estimate.refetch();
          }}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
      <Button
        variant="outline"
        // The spinner replaces the hand-rolled disabled-while-fetching boolean:
        // it keeps the label's width and says the quote is on its way, on the
        // switch's refetch and on a first load alike.
        loading={enablingEnabled || (valid && estimateLoading)}
        disabled={offline || !valid || update.isPending || !estimate.data?.canGenerate}
        onPress={startEnable}
      >
        <Text>{t(preference.enabled ? 'common.save' : 'agentBriefing.enable')}</Text>
      </Button>
    </View>
  );
}
