'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentSetupRunMutations } from '@/hooks/useEnvironmentSetupRuns';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import {
  getLastUsedModel,
  getLastUsedVariant,
  getPreferredInitialModel,
  getPreferredInitialVariant,
  setLastUsedModel,
  setLastUsedVariant,
} from './model-preferences';

export const SETUP_GUIDANCE_MAX_LENGTH = 8000;

/** The setup agent clones the first repository from GitHub. */
export function supportsAgentSetup(repositories: EnvironmentRepository[]): boolean {
  return repositories[0]?.platform === 'github';
}

export type EnvironmentSetupModelChoice = {
  options: ModelOption[];
  isLoading: boolean;
  model: string;
  variants: string[];
  variant: string | undefined;
  selectModel: (model: string) => void;
  selectVariant: (variant: string) => void;
};

export function useEnvironmentSetupAgent({
  organizationId,
  repositories,
  targetEnvironmentId,
  onStarted,
}: {
  organizationId?: string;
  repositories: EnvironmentRepository[];
  targetEnvironmentId?: string;
  onStarted?: () => void;
}) {
  const router = useRouter();
  const { start } = useEnvironmentSetupRunMutations();
  const [guidance, setGuidance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>();
  const { data: modelsData, isLoading: modelsLoading } = useModelSelectorList(
    organizationId,
    true,
    'member'
  );
  const { data: defaults } = useOrganizationDefaults(organizationId);
  const { lastSelected, setLastSelected } = useModelPreferences(organizationId);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsData?.data ?? []).map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
      })),
    [modelsData]
  );
  const model =
    selectedModel ??
    getPreferredInitialModel({
      modelOptions,
      lastUsedModel: lastSelected?.model ?? getLastUsedModel(organizationId),
      defaultModel: defaults?.defaultModel,
    });
  const variants = modelOptions.find(option => option.id === model)?.variants ?? [];
  const variant = getPreferredInitialVariant({
    availableVariants: variants,
    currentVariant: selectedVariant,
    lastUsedVariant:
      (model === lastSelected?.model ? lastSelected.variant : undefined) ??
      getLastUsedVariant(model, organizationId),
  });

  const repositoryError =
    repositories.length > 0 && !supportsAgentSetup(repositories)
      ? 'The first repository must be on GitHub.'
      : null;
  const canStart =
    repositories.length > 0 &&
    !repositoryError &&
    guidance.length <= SETUP_GUIDANCE_MAX_LENGTH &&
    modelOptions.some(option => option.id === model) &&
    !start.isPending;

  const modelChoice: EnvironmentSetupModelChoice = {
    options: modelOptions,
    isLoading: modelsLoading,
    model,
    variants,
    variant,
    selectModel: value => {
      setSelectedModel(value);
      setSelectedVariant(undefined);
      setLastUsedModel(value, organizationId);
      setLastSelected({ model: value });
    },
    selectVariant: value => {
      setSelectedVariant(value);
      setLastUsedVariant(model, value, organizationId);
      setLastSelected({ model, variant: value });
    },
  };

  const startSetup = async () => {
    if (!canStart) return;
    setError(null);
    try {
      const result = await start.mutateAsync({
        organizationId,
        repositories,
        requirements: guidance.trim(),
        model,
        ...(variant ? { variant } : {}),
        targetEnvironmentId,
      });
      onStarted?.();
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start environment setup.');
    }
  };

  return {
    guidance,
    setGuidance,
    modelChoice,
    repositoryError,
    error,
    isStarting: start.isPending,
    canStart,
    startSetup,
  };
}
