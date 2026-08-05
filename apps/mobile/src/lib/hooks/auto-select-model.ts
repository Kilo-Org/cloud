import {
  contextKey,
  resolveModelForContext,
  type StoredModelPreference,
} from '@/lib/hooks/agent-model-preference';
import { type ModelOption } from '@/lib/hooks/use-available-models';

const DEV_DEFAULT_MODEL_ID = 'kilo-auto/efficient';

function pickVariant(model: ModelOption, preferredVariant: string | undefined): string {
  if (preferredVariant && model.variants.includes(preferredVariant)) {
    return preferredVariant;
  }
  return model.variants[0] ?? '';
}

export type AutoSelectInput = {
  models: ModelOption[];
  lastSelected: { model: string; variant?: string } | null;
  stored: StoredModelPreference;
  organizationId: string | undefined;
  orgDefaultModel: string | undefined;
  isDev: boolean;
};

/**
 * Pick the new-session model. In dev builds, `kilo-auto/efficient` wins over every
 * override when the catalog holds it. Otherwise the priority is server lastSelected,
 * then local persisted preference, then org default, then the first catalog entry.
 */
export function pickAutoSelectedModel(
  input: AutoSelectInput
): { model: string; variant: string } | null {
  const { models, lastSelected, stored, organizationId, orgDefaultModel, isDev } = input;
  const devDefaultMatch = isDev ? models.find(m => m.id === DEV_DEFAULT_MODEL_ID) : undefined;
  if (devDefaultMatch) {
    return { model: devDefaultMatch.id, variant: pickVariant(devDefaultMatch, undefined) };
  }
  const serverMatch = lastSelected ? models.find(m => m.id === lastSelected.model) : undefined;
  const localEntry = resolveModelForContext(stored, contextKey(organizationId), models);
  const orgDefaultMatch = orgDefaultModel ? models.find(m => m.id === orgDefaultModel) : undefined;
  const fallback = orgDefaultMatch ?? models[0];
  if (serverMatch) {
    return { model: serverMatch.id, variant: pickVariant(serverMatch, lastSelected?.variant) };
  }
  if (localEntry) {
    return localEntry;
  }
  if (fallback) {
    return { model: fallback.id, variant: pickVariant(fallback, undefined) };
  }
  return null;
}
