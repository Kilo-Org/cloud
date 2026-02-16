import { isModelAllowedProviderAwareClient } from '@/lib/model-allow.client';
import { normalizeModelId } from '@/lib/model-utils';

/** Sentinel value representing "no models allowed" in the model allow list. */
export const MODEL_ALLOW_NONE_SENTINEL = '__none__';

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

export function canonicalizeProviderAllowList(raw: ReadonlyArray<string>): string[] {
  // Empty array is meaningful ("all providers enabled, including future").
  if (raw.length === 0) return [];
  return sortUniqueStrings(raw);
}

export function canonicalizeModelAllowList(raw: ReadonlyArray<string>): string[] {
  // Empty array is meaningful ("all models allowed, including future").
  if (raw.length === 0) return [];

  return sortUniqueStrings(
    raw.map(entry => {
      if (entry.endsWith('/*')) return entry;
      return normalizeModelId(entry);
    })
  );
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
  draftProviderAllowList: ReadonlyArray<string>,
  allProviderSlugsWithEndpoints: ReadonlyArray<string>
): Set<string> {
  if (draftProviderAllowList.length === 0) {
    return new Set(allProviderSlugsWithEndpoints);
  }

  const allowSet = new Set(draftProviderAllowList);
  const enabled = new Set<string>();
  for (const slug of allProviderSlugsWithEndpoints) {
    if (allowSet.has(slug)) {
      enabled.add(slug);
    }
  }

  return enabled;
}

export function computeAllowedModelIds(
  draftModelAllowList: ReadonlyArray<string>,
  openRouterModels: ReadonlyArray<OpenRouterModelSlugSnapshot>,
  openRouterProviders: OpenRouterProviderModelsSnapshot
): Set<string> {
  const allowed = new Set<string>();

  if (draftModelAllowList.length === 0) {
    for (const model of openRouterModels) {
      allowed.add(normalizeModelId(model.slug));
    }
    return allowed;
  }

  // Explicit sentinel check for "no models allowed"
  if (draftModelAllowList.length === 1 && draftModelAllowList[0] === MODEL_ALLOW_NONE_SENTINEL) {
    return allowed;
  }

  const allowListArray = [...draftModelAllowList];
  for (const model of openRouterModels) {
    const normalizedModelId = normalizeModelId(model.slug);
    const isAllowed = isModelAllowedProviderAwareClient(
      normalizedModelId,
      allowListArray,
      openRouterProviders
    );
    if (isAllowed) {
      allowed.add(normalizedModelId);
    }
  }

  return allowed;
}

export function toggleProviderEnabled(params: {
  providerSlug: string;
  nextEnabled: boolean;
  draftProviderAllowList: ReadonlyArray<string>;
  draftModelAllowList: ReadonlyArray<string>;
  allProviderSlugsWithEndpoints: ReadonlyArray<string>;
  hadAllProvidersInitially: boolean;
}): { nextProviderAllowList: string[]; nextModelAllowList: string[] } {
  const {
    providerSlug,
    nextEnabled,
    draftProviderAllowList,
    draftModelAllowList,
    allProviderSlugsWithEndpoints,
    hadAllProvidersInitially,
  } = params;

  let nextModelAllowList = [...draftModelAllowList];
  if (!nextEnabled) {
    if (nextModelAllowList.length !== 0) {
      nextModelAllowList = nextModelAllowList.filter(entry => entry !== `${providerSlug}/*`);
    }
  }
  nextModelAllowList = canonicalizeModelAllowList(nextModelAllowList);

  if (draftProviderAllowList.length === 0) {
    if (nextEnabled) {
      return { nextProviderAllowList: [], nextModelAllowList };
    }

    return {
      nextProviderAllowList: allProviderSlugsWithEndpoints.filter(slug => slug !== providerSlug),
      nextModelAllowList,
    };
  }

  const allowSet = new Set(draftProviderAllowList);
  if (nextEnabled) {
    allowSet.add(providerSlug);
  } else {
    allowSet.delete(providerSlug);
  }

  const nextProviderAllowList = canonicalizeProviderAllowList([...allowSet]);
  if (
    hadAllProvidersInitially &&
    nextProviderAllowList.length === allProviderSlugsWithEndpoints.length
  ) {
    return { nextProviderAllowList: [], nextModelAllowList };
  }

  return { nextProviderAllowList, nextModelAllowList };
}

export function toggleModelAllowed(params: {
  modelId: string;
  nextAllowed: boolean;
  draftModelAllowList: ReadonlyArray<string>;
  allModelIds: ReadonlyArray<string>;
  providerSlugsForModelId: ReadonlyArray<string> | undefined;
  hadAllModelsInitially: boolean;
}): string[] {
  const {
    modelId,
    nextAllowed,
    draftModelAllowList,
    allModelIds,
    providerSlugsForModelId,
    hadAllModelsInitially,
  } = params;

  if (draftModelAllowList.length === 0) {
    if (nextAllowed) {
      return [];
    }
    return canonicalizeModelAllowList(allModelIds.filter(id => id !== modelId));
  }

  const allowSet = new Set(draftModelAllowList);

  if (nextAllowed) {
    allowSet.add(modelId);
  } else {
    // If the model was effectively allowed via one (or more) provider wildcards,
    // disabling it forces those wildcards off.
    for (const providerSlug of providerSlugsForModelId ?? []) {
      allowSet.delete(`${providerSlug}/*`);
    }
    allowSet.delete(modelId);
  }

  const next = canonicalizeModelAllowList([...allowSet]);
  if (hadAllModelsInitially && next.length === allModelIds.length) {
    return [];
  }

  return next;
}

export function toggleAllowFutureModelsForProvider(params: {
  providerSlug: string;
  nextAllowed: boolean;
  draftModelAllowList: ReadonlyArray<string>;
  draftProviderAllowList: ReadonlyArray<string>;
  allProviderSlugsWithEndpoints: ReadonlyArray<string>;
  hadAllProvidersInitially: boolean;
}): { nextModelAllowList: string[]; nextProviderAllowList: string[] } {
  const {
    providerSlug,
    nextAllowed,
    draftModelAllowList,
    draftProviderAllowList,
    allProviderSlugsWithEndpoints,
    hadAllProvidersInitially,
  } = params;

  let nextModelAllowList = [...draftModelAllowList];
  if (nextModelAllowList.length !== 0) {
    const wildcardEntry = `${providerSlug}/*`;
    const allowSet = new Set(nextModelAllowList);
    if (nextAllowed) {
      allowSet.add(wildcardEntry);
    } else {
      allowSet.delete(wildcardEntry);
    }
    nextModelAllowList = canonicalizeModelAllowList([...allowSet]);
  } else {
    nextModelAllowList = [];
  }

  if (!nextAllowed) {
    return {
      nextModelAllowList,
      nextProviderAllowList: canonicalizeProviderAllowList(draftProviderAllowList),
    };
  }

  const { nextProviderAllowList } = toggleProviderEnabled({
    providerSlug,
    nextEnabled: true,
    draftProviderAllowList,
    draftModelAllowList: nextModelAllowList,
    allProviderSlugsWithEndpoints,
    hadAllProvidersInitially,
  });

  return { nextModelAllowList, nextProviderAllowList };
}

export function setAllModelsAllowed(params: {
  nextAllowed: boolean;
  draftModelAllowList: ReadonlyArray<string>;
  allModelIds: ReadonlyArray<string>;
  hadAllModelsInitially: boolean;
}): string[] {
  const { nextAllowed, draftModelAllowList, allModelIds, hadAllModelsInitially } = params;

  if (nextAllowed) {
    // Selecting all: if we started with all models (empty list), return empty.
    // Otherwise return explicit list of all model IDs (preserving any wildcards).
    if (hadAllModelsInitially) {
      return [];
    }
    const wildcards = draftModelAllowList.filter(
      entry => entry.endsWith('/*') && entry !== MODEL_ALLOW_NONE_SENTINEL
    );
    return canonicalizeModelAllowList([...allModelIds, ...wildcards]);
  }

  // Deselecting all: return a sentinel value that won't match any model ID.
  return [MODEL_ALLOW_NONE_SENTINEL];
}

/**
 * Sanitizes a model allow list for persistence to the backend.
 * Removes any client-side sentinel values that shouldn't be stored.
 */
export function sanitizeModelAllowListForPersistence(
  modelAllowList: ReadonlyArray<string>
): string[] {
  return modelAllowList.filter(entry => entry !== MODEL_ALLOW_NONE_SENTINEL);
}

export function setAllProvidersEnabled(params: {
  providerSlugs: ReadonlyArray<string>;
  nextEnabled: boolean;
  draftProviderAllowList: ReadonlyArray<string>;
  draftModelAllowList: ReadonlyArray<string>;
  allProviderSlugsWithEndpoints: ReadonlyArray<string>;
  hadAllProvidersInitially: boolean;
}): { nextProviderAllowList: string[]; nextModelAllowList: string[] } {
  const {
    providerSlugs,
    nextEnabled,
    draftProviderAllowList,
    draftModelAllowList,
    allProviderSlugsWithEndpoints,
    hadAllProvidersInitially,
  } = params;

  const targetSet = new Set(providerSlugs);
  let nextModelAllowList = [...draftModelAllowList];

  // When disabling, remove provider/* wildcards from model allow list
  if (!nextEnabled && nextModelAllowList.length !== 0) {
    nextModelAllowList = nextModelAllowList.filter(entry => {
      if (!entry.endsWith('/*')) return true;
      const providerSlug = entry.slice(0, -2);
      return !targetSet.has(providerSlug);
    });
  }
  nextModelAllowList = canonicalizeModelAllowList(nextModelAllowList);

  // Handle the "all providers enabled" case (empty array)
  if (draftProviderAllowList.length === 0) {
    if (nextEnabled) {
      return { nextProviderAllowList: [], nextModelAllowList };
    }

    // Disabling some providers when all are enabled: create explicit list
    return {
      nextProviderAllowList: allProviderSlugsWithEndpoints.filter(slug => !targetSet.has(slug)),
      nextModelAllowList,
    };
  }

  // Build new allow set
  const allowSet = new Set(draftProviderAllowList);
  if (nextEnabled) {
    for (const slug of providerSlugs) {
      allowSet.add(slug);
    }
  } else {
    for (const slug of providerSlugs) {
      allowSet.delete(slug);
    }
  }

  const nextProviderAllowList = canonicalizeProviderAllowList([...allowSet]);

  // If we've enabled all providers and started with all enabled, return empty array
  if (
    hadAllProvidersInitially &&
    nextProviderAllowList.length === allProviderSlugsWithEndpoints.length
  ) {
    return { nextProviderAllowList: [], nextModelAllowList };
  }

  return { nextProviderAllowList, nextModelAllowList };
}
