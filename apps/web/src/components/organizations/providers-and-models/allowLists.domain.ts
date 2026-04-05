import { normalizeModelId } from '@/lib/model-utils';

export type OpenRouterModelSlugSnapshot = {
  slug: string;
};

export type OpenRouterProviderModelsSnapshot = Array<{
  slug: string;
  models: Array<{
    slug: string;
    endpoint?: unknown;
  }>;
}>;

export function sortUniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function stringListsEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function canonicalizeDenyList(raw: ReadonlyArray<string>): string[] {
  return sortUniqueStrings(raw.map(entry => normalizeModelId(entry)));
}

export function buildModelProvidersIndex(
  openRouterProviders: OpenRouterProviderModelsSnapshot
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const provider of openRouterProviders) {
    for (const model of provider.models) {
      if (!model.endpoint) continue;
      const normalizedModelId = normalizeModelId(model.slug);
      const existing = index.get(normalizedModelId);
      if (existing) {
        existing.add(provider.slug);
      } else {
        index.set(normalizedModelId, new Set([provider.slug]));
      }
    }
  }
  return index;
}

export function computeAllProviderSlugsWithEndpoints(
  openRouterProviders: OpenRouterProviderModelsSnapshot
): string[] {
  return openRouterProviders
    .filter(provider => provider.models.some(model => model.endpoint))
    .map(provider => provider.slug)
    .sort((a, b) => a.localeCompare(b));
}

export function computeEnabledProviderSlugs(
  draftProviderDenyList: ReadonlyArray<string>,
  allProviderSlugsWithEndpoints: ReadonlyArray<string>
): Set<string> {
  const denySet = new Set(draftProviderDenyList);
  return new Set(allProviderSlugsWithEndpoints.filter(slug => !denySet.has(slug)));
}

export function computeAllowedModelIds(
  draftModelDenyList: ReadonlyArray<string>,
  openRouterModels: ReadonlyArray<OpenRouterModelSlugSnapshot>
): Set<string> {
  const denySet = new Set(draftModelDenyList);
  const allowed = new Set<string>();
  for (const model of openRouterModels) {
    const normalizedModelId = normalizeModelId(model.slug);
    if (!denySet.has(normalizedModelId)) {
      allowed.add(normalizedModelId);
    }
  }
  return allowed;
}

export function toggleProviderEnabled(params: {
  providerSlug: string;
  nextEnabled: boolean;
  draftProviderDenyList: ReadonlyArray<string>;
}): string[] {
  const { providerSlug, nextEnabled, draftProviderDenyList } = params;
  const denySet = new Set(draftProviderDenyList);
  if (nextEnabled) {
    denySet.delete(providerSlug);
  } else {
    denySet.add(providerSlug);
  }
  return sortUniqueStrings([...denySet]);
}

export function toggleModelAllowed(params: {
  modelId: string;
  nextAllowed: boolean;
  draftModelDenyList: ReadonlyArray<string>;
}): string[] {
  const { modelId, nextAllowed, draftModelDenyList } = params;
  const denySet = new Set(draftModelDenyList);
  if (nextAllowed) {
    denySet.delete(modelId);
  } else {
    denySet.add(modelId);
  }
  return sortUniqueStrings([...denySet]);
}
