'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeatureFlagVariantKey, usePostHog } from 'posthog-js/react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useKiloClawLatestVersion, useKiloClawMyPin } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { useUser } from '@/hooks/useUser';
import { KILO_AUTO_FRONTIER_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto-model';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCreateModelOptions } from './modelSupport';
import { AutoModelPicker } from './AutoModelPicker';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function CreateInstanceCard({
  mutations,
  onProvisionStart,
}: {
  mutations: ClawMutations;
  onProvisionStart?: () => void;
}) {
  // Evaluate the landing-page experiment flag so PostHog attaches
  // $feature/button-vs-card to events fired in this component.
  useFeatureFlagVariantKey('button-vs-card');
  const posthog = usePostHog();
  const trpc = useTRPC();
  const { data: billingStatus } = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const { data: user, isLoading: isLoadingUser } = useUser();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const { data: myPin, isLoading: isLoadingPin, isError: isPinLookupError } = useKiloClawMyPin();
  const { data: latestVersion, isLoading: isLoadingLatestVersion } = useKiloClawLatestVersion();
  const [selectedModel, setSelectedModel] = useState('');
  const hasAppliedDefault = useRef(false);
  const latestOpenClawVersion = latestVersion?.openclawVersion;
  const hasPin = myPin != null;
  const hasUnknownPinnedVersion = hasPin && !myPin?.openclaw_version;
  const isLoadingProvisionTargetVersion = isLoadingPin || (!hasPin && isLoadingLatestVersion);
  const hasProvisionTargetError = isPinLookupError || hasUnknownPinnedVersion;
  const modelLoadError = isPinLookupError
    ? 'Failed to load version pin state. Refresh and try again.'
    : hasUnknownPinnedVersion
      ? 'Pinned image version metadata is unavailable. Remove or update the pin to select a model.'
      : undefined;

  const canStartTrial = Boolean(billingStatus?.trialEligible);
  const provisionSubtitle = canStartTrial ? '7-day free trial, no credit card required' : undefined;

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      getCreateModelOptions({
        models: (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
        hasPin,
        hasPinLookupError: isPinLookupError,
        pinnedOpenClawVersion: myPin?.openclaw_version,
        latestOpenClawVersion,
        isLoadingPin,
        isLoadingLatestVersion,
      }),
    [
      hasPin,
      isLoadingLatestVersion,
      isLoadingPin,
      isPinLookupError,
      latestOpenClawVersion,
      modelsData,
      myPin,
    ]
  );

  const hasCredits = (user?.total_microdollars_acquired ?? 0) > 0;

  useEffect(() => {
    if (hasAppliedDefault.current || selectedModel !== '' || modelOptions.length === 0) return;
    if (isLoadingUser) return;
    const defaultId = hasCredits ? KILO_AUTO_FRONTIER_MODEL.id : KILO_AUTO_FREE_MODEL.id;
    if (modelOptions.some(m => m.id === defaultId)) {
      setSelectedModel(defaultId);
      hasAppliedDefault.current = true;
    }
  }, [modelOptions, hasCredits, selectedModel, isLoadingUser]);

  function handleCreate() {
    if (hasProvisionTargetError) {
      toast.error(modelLoadError || 'Failed to resolve provision target version.');
      return;
    }

    if (isLoadingModels || isLoadingProvisionTargetVersion) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    if (!selectedModel) {
      toast.error('Please select a default model before creating an instance.');
      return;
    }

    posthog?.capture('claw_create_instance_clicked', {
      selected_model: selectedModel,
    });

    // Capture email before the async mutation so the onSuccess closure
    // doesn't depend on the useUser query still being resolved.
    const email = user?.google_user_email;

    mutations.provision.mutate(
      {
        kilocodeDefaultModel: `kilocode/${selectedModel}`,
      },
      {
        onSuccess: () => {
          onProvisionStart?.();
          // Record a Rewardful lead when an affiliate-referred user starts a trial.
          // No-op if the visitor is not a referral or rw.js didn't load.
          if (email && typeof window.rewardful === 'function') {
            window.rewardful('convert', { email });
          }
        },
        onError: err => {
          toast.error(`Failed to create: ${err.message}`);
        },
      }
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Get Started with KiloClaw</CardTitle>
        <CardDescription>
          Choose a default model to provision your first KiloClaw instance.
          {provisionSubtitle && (
            <>
              <br />
              {provisionSubtitle}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-4 space-y-6">
        <AutoModelPicker
          models={modelOptions}
          value={selectedModel}
          onValueChange={setSelectedModel}
          error={modelLoadError}
          isLoading={isLoadingModels || isLoadingProvisionTargetVersion}
          disabled={
            mutations.provision.isPending ||
            isLoadingModels ||
            isLoadingProvisionTargetVersion ||
            hasProvisionTargetError
          }
        />

        <div className="flex">
          <Button
            onClick={handleCreate}
            disabled={mutations.provision.isPending || !selectedModel || isLoadingUser}
            className="grow bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {mutations.provision.isPending ? 'Setting up...' : 'Get Started'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
