import { useRef } from 'react';

import { type ModelOption } from '@/lib/hooks/use-available-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';

function pickVariant(model: ModelOption, preferredVariant: string | undefined): string {
  if (preferredVariant && model.variants.includes(preferredVariant)) {
    return preferredVariant;
  }
  return model.variants[0] ?? '';
}

function preferredVariantFor(args: {
  serverMatch: ModelOption | undefined;
  serverLastSelected: { variant?: string } | undefined | null;
  localMatch: ModelOption | undefined;
  localPersisted: { variant: string } | null;
}): string | undefined {
  if (args.serverMatch) {
    return args.serverLastSelected?.variant;
  }
  if (args.localMatch) {
    return args.localPersisted?.variant;
  }
  return undefined;
}

export function useAutoSelectModel(
  models: ModelOption[],
  organizationId: string | undefined
): { model: string; variant: string } {
  const { lastSelected } = useModelPreferences(organizationId);
  const { value: persistedModel, hasLoaded: persistedHasLoaded } = usePersistedAgentModel();
  const chosenRef = useRef<{ model: string; variant: string } | null>(null);

  if (!persistedHasLoaded || models.length === 0 || chosenRef.current) {
    return chosenRef.current ?? { model: '', variant: '' };
  }
  const serverMatch = lastSelected ? models.find(m => m.id === lastSelected.model) : undefined;
  const localMatch = persistedModel ? models.find(m => m.id === persistedModel.modelId) : undefined;
  const chosen = serverMatch ?? localMatch ?? models[0];
  if (!chosen) {
    return { model: '', variant: '' };
  }
  const preferredVariant = preferredVariantFor({
    serverMatch,
    serverLastSelected: lastSelected,
    localMatch,
    localPersisted: persistedModel,
  });
  const result = { model: chosen.id, variant: pickVariant(chosen, preferredVariant) };
  chosenRef.current = result;
  return result;
}
