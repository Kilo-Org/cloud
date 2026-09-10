import { modelsByProvider } from '@kilocode/db/schema';
import type { StoredModel } from '@kilocode/db/schema-types';
import { readDb } from '@/lib/drizzle';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import {
  getOpenRouterModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { desc } from 'drizzle-orm';

export type ModelIdToProviderSlugsIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderIndexCacheState = {
  expiresAtMs: number;
  index: ModelIdToProviderSlugsIndex;
};

export type FetchModelsByProviderSnapshot = () => Promise<NormalizedOpenRouterResponse | undefined>;

type ProviderIndexLoaderOptions = {
  fetchSnapshot: FetchModelsByProviderSnapshot;
  /** Gateway `/models/{id}/endpoints` metadata keyed by exact (variant-suffixed) model id. */
  fetchStoredModels: () => Promise<StoredModelMap>;
  ttlMs: number;
  nowMs: () => number;
};

/**
 * Provider slugs that serve one exact model variant, derived from the gateway
 * endpoint metadata stored at sync time. Endpoint tags have the shape
 * `<provider-slug>[/<quantization>]`, so their prefix lives in the same slug
 * namespace as provider allow lists and `provider.only` routing.
 */
export function getEndpointProviderSlugs(model: StoredModel): Set<string> {
  return new Set(
    model.endpoints.flatMap(endpoint =>
      endpoint.tag ? [normalizeInferenceProviderId(endpoint.tag)] : []
    )
  );
}

/**
 * The providers-by-model snapshot collapses variants such as `x/y` and
 * `x/y:free` onto one entry, so each variant inherits providers that only serve
 * its sibling. When endpoint metadata exists for the exact variant, keep only
 * the snapshot providers that actually serve it. Ids without such metadata, and
 * variants whose endpoints cannot be matched to any snapshot provider, keep the
 * collapsed provider set so behaviour degrades to the current one instead of
 * hiding a model that may work.
 */
export function narrowProviderSlugsToVariant(
  snapshotProviderSlugs: ReadonlySet<string>,
  variantModel: StoredModel | undefined
): ReadonlySet<string> {
  if (!variantModel) return snapshotProviderSlugs;
  const variantProviderSlugs = getEndpointProviderSlugs(variantModel);
  if (variantProviderSlugs.size === 0) return snapshotProviderSlugs;
  const narrowed = new Set(
    [...snapshotProviderSlugs].filter(slug => variantProviderSlugs.has(slug))
  );
  return narrowed.size > 0 ? narrowed : snapshotProviderSlugs;
}

/**
 * The exact gateway model id a snapshot entry is served as. Snapshot slugs are
 * unsuffixed; the provider's endpoint carries the variant (`standard`, `free`),
 * which the gateway exposes as `<slug>:<variant>` for anything but `standard`.
 */
export function getSnapshotModelVariantId(model: OpenRouterModel): string {
  const variant = model.endpoint?.variant;
  return variant && variant !== 'standard' ? `${model.slug}:${variant}` : model.slug;
}

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

  /**
   * Providers that can serve `modelId`. Accepts variant-suffixed ids such as
   * `x/y:free`; see `narrowProviderSlugsToVariant`.
   */
  async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
    const index = await loadIndex();
    const snapshotProviderSlugs = index.get(normalizeModelId(modelId));
    if (!snapshotProviderSlugs) return new Set();
    const storedModels = await options.fetchStoredModels();
    return narrowProviderSlugsToVariant(snapshotProviderSlugs, storedModels[modelId]);
  }

  return {
    getIndex: loadIndex,
    getProviderSlugsForModel,
  };
}

export async function fetchLatestModelsByProviderSnapshotFromDb(): Promise<
  NormalizedOpenRouterResponse | undefined
> {
  const result = await readDb
    .select({ data: modelsByProvider.data })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  return result[0]?.data;
}

const DEFAULT_TTL_MS = 30_000;

const defaultLoader = createModelsByProviderIndexLoader({
  fetchSnapshot: fetchLatestModelsByProviderSnapshotFromDb,
  fetchStoredModels: getOpenRouterModelsMetadataFromDatabase,
  ttlMs: DEFAULT_TTL_MS,
  nowMs: () => Date.now(),
});

export async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
  return defaultLoader.getProviderSlugsForModel(modelId);
}

export async function getModelIdToProviderSlugsIndex(): Promise<ModelIdToProviderSlugsIndex> {
  return defaultLoader.getIndex();
}
