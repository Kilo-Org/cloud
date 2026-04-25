import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import type { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';

export type ModelIdToProviderSlugsIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderIndexCacheState = {
  expiresAtMs: number;
  index: ModelIdToProviderSlugsIndex;
};

export type FetchModelsByProviderSnapshot = () => Promise<NormalizedOpenRouterResponse | undefined>;

type ProviderIndexLoaderOptions = {
  fetchSnapshot: FetchModelsByProviderSnapshot;
  ttlMs: number;
  nowMs: () => number;
};

export function buildModelIdToProviderSlugsIndex(
  snapshot: NormalizedOpenRouterResponse
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  for (const provider of snapshot.providers) {
    for (const model of provider.models) {
      const normalizedModelId = normalizeModelId(model.slug);
      const existing = index.get(normalizedModelId);

      if (existing) {
        existing.add(provider.slug);
        continue;
      }

      index.set(normalizedModelId, new Set([provider.slug]));
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
        const index = snapshot ? buildModelIdToProviderSlugsIndex(snapshot) : new Map();

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

export async function fetchLatestModelsByProviderSnapshotFromRedis(): Promise<
  NormalizedOpenRouterResponse | undefined
> {
  const raw = await redisGet(GATEWAY_METADATA_REDIS_KEYS.allProviders);
  if (raw === null) return undefined;
  return JSON.parse(raw) as NormalizedOpenRouterResponse;
}

const DEFAULT_TTL_MS = 30_000;

const defaultLoader = createModelsByProviderIndexLoader({
  fetchSnapshot: fetchLatestModelsByProviderSnapshotFromRedis,
  ttlMs: DEFAULT_TTL_MS,
  nowMs: () => Date.now(),
});

export async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
  return defaultLoader.getProviderSlugsForModel(modelId);
}

export async function getModelIdToProviderSlugsIndex(): Promise<ModelIdToProviderSlugsIndex> {
  return defaultLoader.getIndex();
}
