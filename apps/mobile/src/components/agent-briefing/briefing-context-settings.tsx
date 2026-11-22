import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { ModelSelector } from '@/components/agents/model-selector';
import {
  BriefingEstimateLine,
  type BriefingEstimateLineQuote,
  parseBriefingEstimateLineQuote,
} from '@/components/agent-briefing/briefing-estimate-line';
import { useBriefingEnableFlow } from '@/components/agent-briefing/use-briefing-enable-flow';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type BriefingPreferences } from '@/lib/agent-briefing';
import {
  type BriefingSafeguardField,
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
  const enableFlow = useBriefingEnableFlow();
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
  const [problems, setProblems] = useState<readonly BriefingSafeguardField[]>([]);
  const valid = problems.length === 0;
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
    // The key carries the model and both limits, so a keystroke starts a new
    // read. Keeping the previous quote on screen lets the line and the primary
    // action stay on the last settled estimate while that read runs: without
    // it, typing blanked the line into the skeleton and disabled the action.
    placeholderData: keepPreviousData,
  });
  // One phase per state of the quote line, so no flag pair can render two lines
  // or the wrong one. An unparsable field disables the query, so the last
  // estimate cannot speak for the current limits and `invalid` owns the line.
  // A cached or previous quote renders whatever the read is doing; only with
  // nothing to show does the line name the read itself (offline, failed), and
  // the Retry below belongs to the failed phase alone.
  const quote = estimate.data;
  const limitQuote: BriefingEstimateLineQuote = parseBriefingEstimateLineQuote(
    valid,
    { offline, isError: estimate.isError },
    quote
  );
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
    if (next.kind === 'valid') {
      setLimits(next.limits);
    }
    setProblems(next.kind === 'valid' ? [] : next.fields);
  };
  const startEnable = (): void => {
    enableFlow.start({
      valid,
      refetch: () => estimate.refetch(),
      contextName,
      locale,
      language: i18n.language,
      confirm: estimateToken => {
        update.mutate({
          organizationId,
          enabled: true,
          timezone,
          language: locale,
          model,
          ...limits,
          estimateToken,
        });
      },
    });
  };
  // The estimate's first load is a wait this card owns: the primary action shows
  // the same spinner the switch does while the quote is on its way. A disabled
  // (offline) or failed read never produces a quote, so only a real in-flight
  // fetch is a wait this card can name; `estimate.isPending` alone would hold the
  // spinner forever for the disabled read.
  const estimateLoading = estimate.data === undefined && estimate.isFetching;
  // The card's one safeguard sentence. The field at fault shows it, and both
  // fields reserve its line so the card does not jump when it appears.
  const invalidSafeguards = t('agentBriefing.invalidSafeguards');
  /** Exactly one line per quote phase, rendered by the line's own component. */
  return (
    <Card>
      <Text variant="muted">{t('agentBriefing.scheduledContextHint')}</Text>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1">{t('agentBriefing.scheduledContextEnabled')}</Text>
        {renderRowTrailing({
          kind: 'switch',
          value: preference.enabled,
          disabled: offline || update.isPending || enableFlow.pending,
          accessibilityLabel: t('agentBriefing.scheduledContextEnabled'),
          accessibilityState: {
            checked: preference.enabled,
            disabled: offline || update.isPending || enableFlow.pending,
            // The same two waits the primary action's spinner names: the
            // confirm-and-enable flow, and the estimate's first load. A refetch
            // behind a quote already on the card is not a wait, so typing in a
            // field no longer announces the switch busy.
            busy: enableFlow.pending || estimateLoading,
          },
          onValueChange: next => {
            if (next) {
              startEnable();
            } else {
              update.mutate({ organizationId, enabled: false, timezone, language: locale });
            }
          },
        })}
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
        // The failure is the sentence; the control beside it names the action,
        // the same treatment the estimate failure below the fields gets.
        <View className="gap-2">
          <Text variant="caption">{t('common.couldNotLoadModels')}</Text>
          <Button
            variant="ghost"
            size="sm"
            className={STATE_ACTION_CLASS}
            onPress={() => {
              void catalog.refetch();
            }}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
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
          error={problems.includes('duration') ? invalidSafeguards : undefined}
          reserveErrorMessages={[invalidSafeguards]}
          onChangeText={value => {
            duration.current = value;
            updateLimits();
          }}
        />
        <FormField
          label={t('agentBriefing.spendLimit')}
          defaultValue={spend.current}
          keyboardType="decimal-pad"
          error={problems.includes('spend') ? invalidSafeguards : undefined}
          reserveErrorMessages={[invalidSafeguards]}
          onChangeText={value => {
            spend.current = value;
            updateLimits();
          }}
        />
        <Text variant="caption">{t('agentBriefing.snapshotSafeguards')}</Text>
      </View>
      <BriefingEstimateLine quote={limitQuote} />
      {limitQuote.kind === 'failed' ? (
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
        // switch's refetch and on a first load alike. A refetch behind a kept
        // quote is no wait, and `estimate.data` still holds that quote, so the
        // action neither greys out nor spins while the person types.
        loading={enableFlow.pending || (valid && estimateLoading)}
        disabled={offline || !valid || update.isPending || !estimate.data?.canGenerate}
        onPress={startEnable}
      >
        <Text>{t(preference.enabled ? 'common.save' : 'agentBriefing.enable')}</Text>
      </Button>
    </Card>
  );
}
