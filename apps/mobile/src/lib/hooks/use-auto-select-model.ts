import { useRef } from 'react';

import { type ModelOption, useOrgDefaultModel } from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';

function pickVariant(model: ModelOption, preferredVariant: string | undefined): string {
  if (preferredVariant && model.variants.includes(preferredVariant)) {
    return preferredVariant;
  }
  return model.variants[0] ?? '';
}

const NO_SELECTION = { model: '', variant: '' };

export function useAutoSelectModel(models: ModelOption[], organizationId: string | undefined) {
  const { lastSelected, isLoading } = useModelPreferences(organizationId);
  const { defaultModel: orgDefaultModel, isLoading: orgDefaultIsLoading } =
    useOrgDefaultModel(organizationId);
  const {
    value: persistedModel,
    hasLoaded: persistedHasLoaded,
    setModel: persistModel,
  } = usePersistedAgentModel();
  const chosenRef = useRef<{ model: string; variant: string } | null>(null);

  if (chosenRef.current) {
    return { selection: chosenRef.current, persistModel };
  }
  // Wait for the server preference and org default too, or the shared value
  // loses the race against the local cache on cold start and is never applied.
  if (isLoading || orgDefaultIsLoading || !persistedHasLoaded || models.length === 0) {
    return { selection: NO_SELECTION, persistModel };
  }
  const serverMatch = lastSelected ? models.find(m => m.id === lastSelected.model) : undefined;
  const localMatch = persistedModel ? models.find(m => m.id === persistedModel.modelId) : undefined;
  const orgDefaultMatch = orgDefaultModel ? models.find(m => m.id === orgDefaultModel) : undefined;
  const fallback = orgDefaultMatch ?? models[0];
  if (serverMatch) {
    chosenRef.current = {
      model: serverMatch.id,
      variant: pickVariant(serverMatch, lastSelected?.variant),
    };
  } else if (localMatch) {
    chosenRef.current = {
      model: localMatch.id,
      variant: pickVariant(localMatch, persistedModel?.variant),
    };
  } else if (fallback) {
    chosenRef.current = { model: fallback.id, variant: pickVariant(fallback, undefined) };
  } else {
    return { selection: NO_SELECTION, persistModel };
  }
  return { selection: chosenRef.current, persistModel };
}
