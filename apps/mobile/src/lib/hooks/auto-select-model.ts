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
 * Pick the new-session model. Override priority: server lastSelected, then local
 * persisted preference, then org default. In dev builds only, `kilo-auto/efficient`
 * slots in above the bare catalog fallback (never above an explicit override).
 */
export function pickAutoSelectedModel(
  input: AutoSelectInput
): { model: string; variant: string } | null {
  const { models, lastSelected, stored, organizationId, orgDefaultModel, isDev } = input;
  const serverMatch = lastSelected ? models.find(m => m.id === lastSelected.model) : undefined;
  const localEntry = resolveModelForContext(stored, contextKey(organizationId), models);
  const orgDefaultMatch = orgDefaultModel ? models.find(m => m.id === orgDefaultModel) : undefined;
  const devDefaultMatch = isDev ? models.find(m => m.id === DEV_DEFAULT_MODEL_ID) : undefined;
  const fallback = orgDefaultMatch ?? devDefaultMatch ?? models[0];
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
