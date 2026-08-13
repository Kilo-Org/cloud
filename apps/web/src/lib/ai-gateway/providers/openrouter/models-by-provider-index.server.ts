import { modelsByProvider } from '@kilocode/db/schema';
import type { StoredModel } from '@kilocode/db/schema-types';
import { readDb } from '@/lib/drizzle';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { desc } from 'drizzle-orm';

export type ModelIdToProviderSlugsIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderIndexCacheState = {
  expiresAtMs: number;
  index: ModelIdToProviderSlugsIndex;
};

type ProviderIndexSnapshot = {
  data: NormalizedOpenRouterResponse;
  openrouter: Record<string, StoredModel> | null;
};

export type FetchModelsByProviderSnapshot = () => Promise<ProviderIndexSnapshot | undefined>;

type ProviderIndexLoaderOptions = {
  fetchSnapshot: FetchModelsByProviderSnapshot;
  ttlMs: number;
  nowMs: () => number;
};

export function buildModelIdToProviderSlugsIndex(
  snapshot: NormalizedOpenRouterResponse,
  openRouterModels: Record<string, StoredModel> | null = null
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  function addProvider(modelId: string, providerSlug: string): void {
    const existing = index.get(modelId);
    if (existing) {
      existing.add(providerSlug);
    } else {
      index.set(modelId, new Set([providerSlug]));
    }
  }

  for (const provider of snapshot.providers) {
    for (const model of provider.models) {
      const normalizedModelId = normalizeModelId(model.slug).trim().toLowerCase();
      addProvider(normalizedModelId, provider.slug);
      if (model.endpoint?.is_free) {
        addProvider(`${normalizedModelId}:free`, provider.slug);
      }
    }
  }

  const providerSlugsByName = new Map<string, string>();
  for (const provider of snapshot.providers) {
    providerSlugsByName.set(provider.slug.toLowerCase(), provider.slug);
    providerSlugsByName.set(provider.name.toLowerCase(), provider.slug);
    providerSlugsByName.set(provider.displayName.toLowerCase(), provider.slug);
  }

  for (const model of Object.values(openRouterModels ?? {})) {
    const modelId = model.id.trim().toLowerCase();
    if (!modelId.includes(':')) continue;

    for (const endpoint of model.endpoints) {
      const providerSlug = endpoint.tag
        ? normalizeInferenceProviderId(endpoint.tag)
        : endpoint.provider_name
          ? providerSlugsByName.get(endpoint.provider_name.toLowerCase())
          : undefined;
      if (providerSlug) {
        addProvider(modelId, providerSlug);
      }
    }
  }

  return index;
}

export function createModelsByProviderIndexLoader(options: ProviderIndexLoaderOptions) {
  let cache: ProviderIndexCacheState | undefined;
  let inFlight: Promise<ProviderIndexCacheState> | undefined;

  async function loadIndex(): Promise<ModelIdToProviderSlugsIndex> {
    const now = options.nowMs();
    if (cache && cache.expiresAtMs > now) {
      return cache.index;
    }

    if (inFlight) {
      const state = await inFlight;
      return state.index;
    }

    inFlight = (async (): Promise<ProviderIndexCacheState> => {
      try {
        const snapshot = await options.fetchSnapshot().catch(() => undefined);
        const index = snapshot
          ? buildModelIdToProviderSlugsIndex(snapshot.data, snapshot.openrouter)
          : new Map();

        return {
          expiresAtMs: options.nowMs() + options.ttlMs,
          index,
        };
      } finally {
        inFlight = undefined;
      }
    })();

    cache = await inFlight;
    return cache.index;
  }

  async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
    const index = await loadIndex();
    return index.get(modelId) ?? new Set();
  }

  return {
    getIndex: loadIndex,
    getProviderSlugsForModel,
  };
}

export async function fetchLatestModelsByProviderSnapshotFromDb(): Promise<
  ProviderIndexSnapshot | undefined
> {
  const result = await readDb
    .select({ data: modelsByProvider.data, openrouter: modelsByProvider.openrouter })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  return result[0];
}

const DEFAULT_TTL_MS = 30_000;

const defaultLoader = createModelsByProviderIndexLoader({
  fetchSnapshot: fetchLatestModelsByProviderSnapshotFromDb,
  ttlMs: DEFAULT_TTL_MS,
  nowMs: () => Date.now(),
});

export async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
  return defaultLoader.getProviderSlugsForModel(modelId);
}

export async function getModelIdToProviderSlugsIndex(): Promise<ModelIdToProviderSlugsIndex> {
  return defaultLoader.getIndex();
}
