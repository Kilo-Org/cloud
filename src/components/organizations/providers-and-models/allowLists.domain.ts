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
  targetModelIds: ReadonlyArray<string>;
  draftModelAllowList: ReadonlyArray<string>;
  allModelIds: ReadonlyArray<string>;
  hadAllModelsInitially: boolean;
}): string[] {
  const { nextAllowed, targetModelIds, draftModelAllowList, allModelIds, hadAllModelsInitially } =
    params;

  const targetSet = new Set(targetModelIds);

  if (nextAllowed) {
    // When the draft is the sentinel (nothing allowed), start from scratch with just the targets.
    if (draftModelAllowList.length === 1 && draftModelAllowList[0] === MODEL_ALLOW_NONE_SENTINEL) {
      if (hadAllModelsInitially && targetSet.size === allModelIds.length) {
        return [];
      }
      return canonicalizeModelAllowList([...targetModelIds]);
    }

    // Merge targets into the existing allow list.
    const merged = new Set(draftModelAllowList);
    for (const id of targetModelIds) {
      merged.add(id);
    }

    // If we've now selected every model and started with all, return empty (= all allowed).
    if (hadAllModelsInitially && allModelIds.every(id => merged.has(id))) {
      return [];
    }

    return canonicalizeModelAllowList([...merged]);
  }

  // Deselecting: remove targets from the allow list.
  if (draftModelAllowList.length === 0) {
    // Currently "all allowed" (empty list) — create explicit list of everything except targets.
    const remaining = allModelIds.filter(id => !targetSet.has(id));
    if (remaining.length === 0) {
      return [MODEL_ALLOW_NONE_SENTINEL];
    }
    return canonicalizeModelAllowList(remaining);
  }

  const remaining = draftModelAllowList.filter(
    entry => !targetSet.has(entry) && entry !== MODEL_ALLOW_NONE_SENTINEL
  );
  // Preserve wildcards that don't correspond to a target model ID
  if (remaining.length === 0) {
    return [MODEL_ALLOW_NONE_SENTINEL];
  }
  return canonicalizeModelAllowList(remaining);
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
