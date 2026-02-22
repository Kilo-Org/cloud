import { isModelAllowedProviderAwareClient } from '@/lib/model-allow.client';
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
  openRouterProviders: OpenRouterProviderModelsSnapshot,
  enabledProviderSlugs?: ReadonlySet<string>,
  modelProvidersIndex?: Map<string, Set<string>>
): Set<string> {
  const allowed = new Set<string>();
  const resolvedModelProvidersIndex = enabledProviderSlugs
    ? (modelProvidersIndex ?? buildModelProvidersIndex(openRouterProviders))
    : null;

  if (draftModelAllowList.length === 0) {
    for (const model of openRouterModels) {
      const normalizedModelId = normalizeModelId(model.slug);

      // If enabledProviderSlugs is provided, filter models without enabled providers
      if (enabledProviderSlugs && resolvedModelProvidersIndex) {
        const providersForModel = resolvedModelProvidersIndex.get(normalizedModelId);
        if (!providersForModel) continue; // Exclude models with unknown providers
        let hasEnabledProvider = false;
        for (const providerSlug of providersForModel) {
          if (enabledProviderSlugs.has(providerSlug)) {
            hasEnabledProvider = true;
            break;
          }
        }
        if (!hasEnabledProvider) continue;
      }

      allowed.add(normalizedModelId);
    }
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
    if (!isAllowed) {
      continue;
    }

    // If enabledProviderSlugs is provided, also check that at least one provider
    // offering this model is enabled
    if (enabledProviderSlugs && resolvedModelProvidersIndex) {
      const providersForModel = resolvedModelProvidersIndex.get(normalizedModelId);
      if (!providersForModel) continue; // Exclude models with unknown providers
      let hasEnabledProvider = false;
      for (const providerSlug of providersForModel) {
        if (enabledProviderSlugs.has(providerSlug)) {
          hasEnabledProvider = true;
          break;
        }
      }
      if (!hasEnabledProvider) {
        continue;
      }
    }

    allowed.add(normalizedModelId);
  }

  return allowed;
}

/**
 * Compute which models from the current allow list would have zero enabled providers
 * if the given provider were disabled.
 */
export function computeModelsOnlyFromProvider(params: {
  providerSlug: string;
  draftModelAllowList: ReadonlyArray<string>;
  draftProviderAllowList: ReadonlyArray<string>;
  allProviderSlugsWithEndpoints: ReadonlyArray<string>;
  modelProvidersIndex: Map<string, Set<string>>;
}): string[] {
  const {
    providerSlug,
    draftModelAllowList,
    draftProviderAllowList,
    allProviderSlugsWithEndpoints,
    modelProvidersIndex,
  } = params;

  // Compute which providers would remain enabled after disabling this one
  const enabledAfterDisable = computeEnabledProviderSlugs(
    draftProviderAllowList.length === 0
      ? allProviderSlugsWithEndpoints.filter(slug => slug !== providerSlug)
      : draftProviderAllowList.filter(slug => slug !== providerSlug),
    allProviderSlugsWithEndpoints
  );

  const orphanedModels: string[] = [];

  // Collect all model IDs to check, expanding wildcards to concrete models.
  // An empty allow list means "all models allowed", so check every known model.
  const modelIdsToCheck = new Set<string>();
  if (draftModelAllowList.length === 0) {
    for (const modelId of modelProvidersIndex.keys()) {
      modelIdsToCheck.add(modelId);
    }
  } else {
    for (const entry of draftModelAllowList) {
      if (entry.endsWith('/*')) {
        const providerPrefix = entry.slice(0, -2);
        for (const [modelId, providers] of modelProvidersIndex) {
          // Expand by provider-membership OR namespace prefix, mirroring the two wildcard
          // match paths in isModelAllowedProviderAwareClient.
          if (providers.has(providerPrefix) || modelId.startsWith(`${providerPrefix}/`)) {
            modelIdsToCheck.add(modelId);
          }
        }
      } else {
        modelIdsToCheck.add(normalizeModelId(entry));
      }
    }
  }

  // Check each model for orphan status
  for (const modelId of modelIdsToCheck) {
    const providersForModel = modelProvidersIndex.get(modelId);
    if (!providersForModel) continue;

    // Check if this model has any enabled providers remaining
    let hasEnabledProvider = false;
    for (const p of providersForModel) {
      if (enabledAfterDisable.has(p)) {
        hasEnabledProvider = true;
        break;
      }
    }
    if (!hasEnabledProvider) {
      orphanedModels.push(modelId);
    }
  }

  return orphanedModels;
}

export function toggleProviderEnabled(params: {
  providerSlug: string;
  nextEnabled: boolean;
  draftProviderAllowList: ReadonlyArray<string>;
  draftModelAllowList: ReadonlyArray<string>;
  allProviderSlugsWithEndpoints: ReadonlyArray<string>;
  hadAllProvidersInitially: boolean;
  modelProvidersIndex?: Map<string, Set<string>>;
}): { nextProviderAllowList: string[]; nextModelAllowList: string[] } {
  const {
    providerSlug,
    nextEnabled,
    draftProviderAllowList,
    draftModelAllowList,
    allProviderSlugsWithEndpoints,
    hadAllProvidersInitially,
    modelProvidersIndex,
  } = params;

  let nextModelAllowList = [...draftModelAllowList];
  if (!nextEnabled) {
    if (nextModelAllowList.length !== 0) {
      // Remove provider wildcard
      nextModelAllowList = nextModelAllowList.filter(entry => entry !== `${providerSlug}/*`);
    }

    // Remove models that would have zero enabled providers.
    // This must also run when the model allow list is empty ("allow all"), because
    // computeModelsOnlyFromProvider treats an empty list as "all models in the index".
    if (modelProvidersIndex) {
      const orphanedModels = computeModelsOnlyFromProvider({
        providerSlug,
        draftModelAllowList: nextModelAllowList,
        draftProviderAllowList,
        allProviderSlugsWithEndpoints,
        modelProvidersIndex,
      });
      if (orphanedModels.length > 0) {
        if (nextModelAllowList.length === 0) {
          // Materialise the implicit "all models" list, then exclude the orphaned ones.
          // This transitions the allow list from "allow all" to "allow all except orphans".
          const orphanedSet = new Set(orphanedModels);
          nextModelAllowList = [...modelProvidersIndex.keys()].filter(
            modelId => !orphanedSet.has(modelId)
          );
        } else {
          const orphanedSet = new Set(orphanedModels);
          nextModelAllowList = nextModelAllowList.filter(entry => {
            if (entry.endsWith('/*')) return true;
            return !orphanedSet.has(normalizeModelId(entry));
          });
        }
      }
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
