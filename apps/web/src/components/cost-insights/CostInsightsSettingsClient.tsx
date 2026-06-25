'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import { CostInsightsLoadError } from './shared/CostInsightsLoadError';
import { CostInsightsSettingsView } from './settings/CostInsightsSettingsView';
import type { CostInsightsSettingsData, CostInsightsSettingsPatch } from './types';

type SettingsFormState = Pick<
  CostInsightsSettingsData,
  'enabled' | 'suggestionsEnabled' | 'thresholdUsd'
>;

type CostInsightsSettingsClientProps = {
  organizationId?: string;
};

const THRESHOLD_USD_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

function validateThresholdUsd(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!THRESHOLD_USD_PATTERN.test(trimmed)) {
    return 'Enter a positive USD amount with up to 2 decimal places.';
  }
  const [wholePart, centsPart = ''] = trimmed.split('.');
  const dollars = Number.parseInt(wholePart, 10);
  const cents = Number.parseInt(centsPart.padEnd(2, '0') || '0', 10);
  const totalCents = dollars * 100 + cents;
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return 'Enter an amount greater than $0.00.';
  }
  return undefined;
}

export function CostInsightsSettingsClient({ organizationId }: CostInsightsSettingsClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SettingsFormState | null>(null);

  const personalSettingsQuery = useQuery({
    ...trpc.costInsights.getSettings.queryOptions(),
    enabled: !organizationId,
  });
  const organizationSettingsQuery = useQuery({
    ...trpc.organizations.costInsights.getSettings.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: Boolean(organizationId),
  });
  const settingsQuery = organizationId ? organizationSettingsQuery : personalSettingsQuery;
  const settings = settingsQuery.data;

  useEffect(() => {
    if (!settings) return;
    setForm({
      enabled: settings.enabled,
      suggestionsEnabled: settings.suggestionsEnabled,
      thresholdUsd: settings.thresholdUsd,
    });
  }, [settings?.enabled, settings?.suggestionsEnabled, settings?.thresholdUsd]);

  const invalidateCostInsights = async () => {
    if (organizationId) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getDashboard.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getSettings.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.listEvents.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getAttentionState.queryKey({
            organizationId,
          }),
        }),
      ]);
      return;
    }

    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.getDashboard.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.getSettings.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.listEvents.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.getAttentionState.queryKey(),
      }),
    ]);
  };

  const personalUpdateMutation = useMutation(
    trpc.costInsights.updateSettings.mutationOptions({
      onSuccess: () => {
        toast.success('Cost Insights settings saved');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not save Cost Insights settings'),
    })
  );
  const organizationUpdateMutation = useMutation(
    trpc.organizations.costInsights.updateSettings.mutationOptions({
      onSuccess: () => {
        toast.success('Cost Insights settings saved');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not save Cost Insights settings'),
    })
  );

  if (settingsQuery.isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (settingsQuery.isError || !settings || !form) return <CostInsightsLoadError />;

  const validation = validateThresholdUsd(form.thresholdUsd);
  const dirty =
    form.enabled !== settings.enabled ||
    form.suggestionsEnabled !== settings.suggestionsEnabled ||
    form.thresholdUsd !== settings.thresholdUsd;
  const activeMutation = organizationId ? organizationUpdateMutation : personalUpdateMutation;
  const saveState: CostInsightsSettingsData['saveState'] = activeMutation.isPending
    ? 'saving'
    : activeMutation.isError
      ? 'error'
      : dirty
        ? 'dirty'
        : 'saved';

  const data: CostInsightsSettingsData = {
    ...settings,
    ...form,
    saveState,
    validations: validation ? [validation] : undefined,
  };

  const handleChange = (patch: CostInsightsSettingsPatch) => {
    setForm(current => (current ? { ...current, ...patch } : current));
  };

  const handleSave = () => {
    if (!dirty || validation || settings.readOnly) return;
    const input = {
      spendAlertsEnabled: form.enabled,
      costSuggestionsEnabled: form.suggestionsEnabled,
      spendThresholdUsd: form.thresholdUsd.trim() === '' ? null : form.thresholdUsd.trim(),
    };
    if (organizationId) {
      organizationUpdateMutation.mutate({ organizationId, ...input });
      return;
    }
    personalUpdateMutation.mutate(input);
  };

  return <CostInsightsSettingsView data={data} onChange={handleChange} onSave={handleSave} />;
}
