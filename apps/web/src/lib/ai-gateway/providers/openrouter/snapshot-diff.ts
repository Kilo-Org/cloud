import type { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';

export type SnapshotDiff = {
  /** providerSlug -> sorted list of normalized model ids newly offered by that provider */
  addedByProvider: Map<string, string[]>;
  /** providerSlug -> sorted list of normalized model ids no longer offered by that provider */
  removedByProvider: Map<string, string[]>;
  /** modelId -> set of providerSlugs that offered it in the OLD snapshot */
  oldModelProvidersIndex: Map<string, Set<string>>;
  /** modelId -> set of providerSlugs that offer it in the NEW snapshot */
  newModelProvidersIndex: Map<string, Set<string>>;
};

function buildModelProvidersIndex(
  snapshot: NormalizedOpenRouterResponse
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const provider of snapshot.providers) {
    for (const model of provider.models) {
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

function emptyDiff(
  oldIndex: Map<string, Set<string>>,
  newIndex: Map<string, Set<string>>
): SnapshotDiff {
  return {
    addedByProvider: new Map(),
    removedByProvider: new Map(),
    oldModelProvidersIndex: oldIndex,
    newModelProvidersIndex: newIndex,
  };
}

/**
 * Compare two OpenRouter snapshots and produce the set of provider→model
 * additions and removals implied by the diff.
 *
 * A `(provider, model)` pair is "added" when the NEW snapshot contains that
 * pair and the OLD snapshot did not. This naturally covers two scenarios:
 *   1. A brand-new model on an existing provider (e.g. `z-ai/glm-5.1` appears
 *      under `z-ai`).
 *   2. An existing model newly offered by an additional provider.
 *
 * Similarly, a `(provider, model)` pair is "removed" when the OLD snapshot
 * contained it and the NEW snapshot does not.
 *
 * When `oldSnapshot` is null (first run / fresh database), returns empty
 * add/remove maps so callers produce no audit log flood.
 */
export function computeSnapshotDiff(
  oldSnapshot: NormalizedOpenRouterResponse | null,
  newSnapshot: NormalizedOpenRouterResponse
): SnapshotDiff {
  const newIndex = buildModelProvidersIndex(newSnapshot);

  if (oldSnapshot === null) {
    return emptyDiff(new Map(), newIndex);
  }

  const oldIndex = buildModelProvidersIndex(oldSnapshot);

  const addedByProvider = new Map<string, string[]>();
  const removedByProvider = new Map<string, string[]>();

  for (const [modelId, newProviders] of newIndex) {
    const oldProviders = oldIndex.get(modelId);
    for (const providerSlug of newProviders) {
      if (!oldProviders || !oldProviders.has(providerSlug)) {
        const list = addedByProvider.get(providerSlug);
        if (list) {
          list.push(modelId);
        } else {
          addedByProvider.set(providerSlug, [modelId]);
        }
      }
    }
  }

  for (const [modelId, oldProviders] of oldIndex) {
    const newProviders = newIndex.get(modelId);
    for (const providerSlug of oldProviders) {
      if (!newProviders || !newProviders.has(providerSlug)) {
        const list = removedByProvider.get(providerSlug);
        if (list) {
          list.push(modelId);
        } else {
          removedByProvider.set(providerSlug, [modelId]);
        }
      }
    }
  }

  for (const list of addedByProvider.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }
  for (const list of removedByProvider.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }

  return {
    addedByProvider,
    removedByProvider,
    oldModelProvidersIndex: oldIndex,
    newModelProvidersIndex: newIndex,
  };
}
