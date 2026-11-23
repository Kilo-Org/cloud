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
 * Which input decided the pick. `org-default-failed` reporting and the
 * catalogue fallback both need to tell "the organization default decided"
 * from "nothing did, so the first row did".
 */
export type AutoSelectedModel = {
  model: string;
  variant: string;
  source: 'last-selected' | 'stored' | 'dev-default' | 'org-default' | 'catalog-first';
};

/**
 * Pick the new-session model. A persisted choice is always restored first so
 * the user's last picked model/effort combo comes back: the server
 * `lastSelected`, then the local persisted preference. When neither is
 * available in the catalog, dev builds fall back to `kilo-auto/efficient`,
 * then the org default, then the first catalog entry.
 */
export function pickAutoSelectedModel(input: AutoSelectInput): AutoSelectedModel | null {
  const { models, lastSelected, stored, organizationId, orgDefaultModel, isDev } = input;
  const serverMatch = lastSelected ? models.find(m => m.id === lastSelected.model) : undefined;
  if (serverMatch) {
    return {
      model: serverMatch.id,
      variant: pickVariant(serverMatch, lastSelected?.variant),
      source: 'last-selected',
    };
  }
  const localEntry = resolveModelForContext(stored, contextKey(organizationId), models);
  if (localEntry) {
    return { ...localEntry, source: 'stored' };
  }
  const devDefaultMatch = isDev ? models.find(m => m.id === DEV_DEFAULT_MODEL_ID) : undefined;
  if (devDefaultMatch) {
    return {
      model: devDefaultMatch.id,
      variant: pickVariant(devDefaultMatch, undefined),
      source: 'dev-default',
    };
  }
  const orgDefaultMatch = orgDefaultModel ? models.find(m => m.id === orgDefaultModel) : undefined;
  const fallback = orgDefaultMatch ?? models[0];
  if (fallback) {
    return {
      model: fallback.id,
      variant: pickVariant(fallback, undefined),
      source: orgDefaultMatch ? 'org-default' : 'catalog-first',
    };
  }
  return null;
}
