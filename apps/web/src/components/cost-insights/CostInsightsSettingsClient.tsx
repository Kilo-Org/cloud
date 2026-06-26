'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import { CostInsightsLoadError } from './shared/CostInsightsLoadError';
import { CostInsightsSettingsView } from './settings/CostInsightsSettingsView';
import type { CostInsightsSettingsData, CostInsightsSettingsPatch } from './types';
import { useCostInsightsTracking } from './useCostInsightsTracking';

type SettingsFormState = Pick<
  CostInsightsSettingsData,
  'enabled' | 'anomalyAlertsEnabled' | 'suggestionsEnabled' | 'thresholdUsd' | 'threshold30DayUsd'
> & {
  threshold7DayUsd: string;
};

type SettingsMutationInput = {
  spendAlertsEnabled: boolean;
  anomalyAlertsEnabled: boolean;
  costSuggestionsEnabled: boolean;
  spendThresholdUsd: string | null;
  spend7DayThresholdUsd: string | null;
  spend30DayThresholdUsd: string | null;
};

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

function readThreshold7DayUsd(settings: object): string {
  if (!('threshold7DayUsd' in settings)) return '';
  return typeof settings.threshold7DayUsd === 'string' ? settings.threshold7DayUsd : '';
}

export function CostInsightsSettingsClient({ organizationId }: CostInsightsSettingsClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { trackUiInteraction } = useCostInsightsTracking(organizationId);
  const trackedSettingsOwner = useRef<string | undefined>(undefined);

  const {
    data: personalSettings,
    isLoading: personalSettingsLoading,
    isError: personalSettingsError,
    refetch: refetchPersonalSettings,
  } = useQuery({
    ...trpc.costInsights.getSettings.queryOptions(),
    enabled: !organizationId,
  });
  const {
    data: organizationSettings,
    isLoading: organizationSettingsLoading,
    isError: organizationSettingsError,
    refetch: refetchOrganizationSettings,
  } = useQuery({
    ...trpc.organizations.costInsights.getSettings.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: Boolean(organizationId),
  });

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
          queryKey: trpc.organizations.costInsights.listEvents.queryKey(),
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

  const {
    mutate: updatePersonalSettings,
    isPending: personalUpdatePending,
    isError: personalUpdateError,
  } = useMutation(
    trpc.costInsights.updateSettings.mutationOptions({
      onSuccess: async () => {
        await invalidateCostInsights();
        toast.success('Cost Insights settings saved');
      },
      onError: error => toast.error(error.message || 'Could not save Cost Insights settings'),
    })
  );
  const {
    mutate: updateOrganizationSettings,
    isPending: organizationUpdatePending,
    isError: organizationUpdateError,
  } = useMutation(
    trpc.organizations.costInsights.updateSettings.mutationOptions({
      onSuccess: async () => {
        await invalidateCostInsights();
        toast.success('Cost Insights settings saved');
      },
      onError: error => toast.error(error.message || 'Could not save Cost Insights settings'),
    })
  );

  const settings = organizationId ? organizationSettings : personalSettings;
  const isLoading = organizationId ? organizationSettingsLoading : personalSettingsLoading;
  const isError = organizationId ? organizationSettingsError : personalSettingsError;
  const isSaving = organizationId ? organizationUpdatePending : personalUpdatePending;
  const saveFailed = organizationId ? organizationUpdateError : personalUpdateError;

  useEffect(() => {
    if (!settings) return;
    const ownerKey = organizationId ?? 'personal';
    if (trackedSettingsOwner.current === ownerKey) return;
    trackedSettingsOwner.current = ownerKey;
    trackUiInteraction({
      interaction: 'settings_viewed',
      spendAlertsEnabled: settings.enabled,
      costSuggestionsEnabled: settings.suggestionsEnabled,
      threshold24hConfigured: settings.thresholdUsd !== '',
      threshold7dConfigured: readThreshold7DayUsd(settings) !== '',
      threshold30dConfigured: settings.threshold30DayUsd !== '',
      readOnly: Boolean(settings.readOnly),
    });
  }, [organizationId, settings, trackUiInteraction]);

  if (isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (isError || !settings) {
    return (
      <CostInsightsLoadError
        onRetry={() => {
          void (organizationId ? refetchOrganizationSettings() : refetchPersonalSettings());
        }}
      />
    );
  }

  const settingsData = {
    ...settings,
    threshold7DayUsd: readThreshold7DayUsd(settings),
  } satisfies CostInsightsSettingsData;
  const formKey = [
    organizationId ?? 'personal',
    settingsData.enabled,
    settingsData.anomalyAlertsEnabled,
    settingsData.suggestionsEnabled,
    settingsData.thresholdUsd,
    settingsData.threshold7DayUsd,
    settingsData.threshold30DayUsd,
  ].join(':');

  const saveSettings = (input: SettingsMutationInput) => {
    if (organizationId) {
      updateOrganizationSettings({ organizationId, ...input });
      return;
    }
    updatePersonalSettings(input);
  };

  return (
    <CostInsightsSettingsForm
      key={formKey}
      settings={settingsData}
      isSaving={isSaving}
      saveFailed={saveFailed}
      onSave={saveSettings}
    />
  );
}

function CostInsightsSettingsForm({
  settings,
  isSaving,
  saveFailed,
  onSave,
}: {
  settings: CostInsightsSettingsData;
  isSaving: boolean;
  saveFailed: boolean;
  onSave: (input: SettingsMutationInput) => void;
}) {
  const [form, setForm] = useState<SettingsFormState>(() => ({
    enabled: settings.enabled,
    anomalyAlertsEnabled: settings.anomalyAlertsEnabled,
    suggestionsEnabled: settings.suggestionsEnabled,
    thresholdUsd: settings.thresholdUsd,
    threshold7DayUsd: settings.threshold7DayUsd ?? '',
    threshold30DayUsd: settings.threshold30DayUsd,
  }));
  const validations = {
    thresholdUsd: validateThresholdUsd(form.thresholdUsd),
    threshold7DayUsd: validateThresholdUsd(form.threshold7DayUsd),
    threshold30DayUsd: validateThresholdUsd(form.threshold30DayUsd),
  };
  const hasValidationError = Boolean(
    validations.thresholdUsd || validations.threshold7DayUsd || validations.threshold30DayUsd
  );
  const dirty =
    form.enabled !== settings.enabled ||
    form.anomalyAlertsEnabled !== settings.anomalyAlertsEnabled ||
    form.suggestionsEnabled !== settings.suggestionsEnabled ||
    form.thresholdUsd !== settings.thresholdUsd ||
    form.threshold7DayUsd !== settings.threshold7DayUsd ||
    form.threshold30DayUsd !== settings.threshold30DayUsd;
  const saveState: CostInsightsSettingsData['saveState'] = isSaving
    ? 'saving'
    : saveFailed
      ? 'error'
      : dirty
        ? 'dirty'
        : 'saved';

  const data: CostInsightsSettingsData = {
    ...settings,
    ...form,
    saveState,
    validations: hasValidationError ? validations : undefined,
  };

  const handleChange = (patch: CostInsightsSettingsPatch) => {
    setForm(current => ({ ...current, ...patch }));
  };

  const handleSave = () => {
    if (!dirty || hasValidationError || settings.readOnly) return;
    onSave({
      spendAlertsEnabled: form.enabled,
      anomalyAlertsEnabled: form.anomalyAlertsEnabled,
      costSuggestionsEnabled: form.suggestionsEnabled,
      spendThresholdUsd: form.thresholdUsd.trim() === '' ? null : form.thresholdUsd.trim(),
      spend7DayThresholdUsd:
        form.threshold7DayUsd.trim() === '' ? null : form.threshold7DayUsd.trim(),
      spend30DayThresholdUsd:
        form.threshold30DayUsd.trim() === '' ? null : form.threshold30DayUsd.trim(),
    });
  };

  return <CostInsightsSettingsView data={data} onChange={handleChange} onSave={handleSave} />;
}
