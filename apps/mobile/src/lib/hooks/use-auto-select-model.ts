import { useRef } from 'react';

import { contextKey, resolveModelForContext } from '@/lib/hooks/agent-model-preference';
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

export function useAutoSelectModel(
  models: ModelOption[],
  organizationId: string | undefined
): { model: string; variant: string } {
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
  const serverMatch = lastSelected ? models.find(m => m.id === lastSelected.model) : undefined;
  const localEntry = resolveModelForContext(stored, contextKey(organizationId), models);
  const orgDefaultMatch = orgDefaultModel ? models.find(m => m.id === orgDefaultModel) : undefined;
  const fallback = orgDefaultMatch ?? models[0];
  if (serverMatch) {
    chosenRef.current = {
      model: serverMatch.id,
      variant: pickVariant(serverMatch, lastSelected?.variant),
    };
  } else if (localEntry) {
    chosenRef.current = localEntry;
  } else if (fallback) {
    chosenRef.current = { model: fallback.id, variant: pickVariant(fallback, undefined) };
  } else {
    return NO_SELECTION;
  }
  return chosenRef.current;
}
