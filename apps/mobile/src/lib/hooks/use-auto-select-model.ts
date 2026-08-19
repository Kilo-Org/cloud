import { useRef } from 'react';

import { pickAutoSelectedModel } from '@/lib/hooks/auto-select-model';
import { type ModelOption, useOrgDefaultModel } from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';

const NO_SELECTION = { model: '', variant: '' };

export function useAutoSelectModel(models: ModelOption[], organizationId: string | undefined) {
  const { lastSelected, isLoading } = useModelPreferences(organizationId);
  const { defaultModel: orgDefaultModel, isLoading: orgDefaultIsLoading } =
    useOrgDefaultModel(organizationId);
  const { stored, hasLoaded } = usePersistedAgentModel();
  const chosenRef = useRef<{ model: string; variant: string } | null>(null);

  if (chosenRef.current) {
    return chosenRef.current;
  }
  // Wait for the server preference and org default too, or the shared value
  // loses the race against the local cache on cold start and is never applied.
  if (isLoading || orgDefaultIsLoading || !hasLoaded || models.length === 0) {
    return NO_SELECTION;
  }
  const picked = pickAutoSelectedModel({
    models,
    lastSelected,
    stored,
    organizationId,
    orgDefaultModel,
    isDev: __DEV__,
  });
  if (!picked) {
    return NO_SELECTION;
  }
  chosenRef.current = picked;
  return chosenRef.current;
}
