import { modelsByProvider } from '@kilocode/db/schema';
import type {
  GatewayModelMap,
  GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getSnapshotModelVariantId,
  normalizeModelId,
} from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  normalizeInferenceProviderId,
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { modelTrains } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/model-data-policy';
import type { NormalizedOpenRouterResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { desc, eq } from 'drizzle-orm';

export type ModelIdToProviderSlugsIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderIndexCacheState = {
  expiresAtMs: number;
  /** The `models_by_provider` row the index was built from; undefined after a failed read. */
  snapshotId?: number;
  index: ModelIdToProviderSlugsIndex;
  dataCollectionRequiredModelIds: ReadonlySet<string>;
};

export type ModelsByProviderSnapshotRow = { id: number; data: NormalizedOpenRouterResponse };

export type FetchModelsByProviderSnapshot = () => Promise<ModelsByProviderSnapshotRow | undefined>;

export type ProviderIndexLoaderOptions = {
  fetchSnapshot: FetchModelsByProviderSnapshot;
  fetchSnapshotById: (id: number) => Promise<ModelsByProviderSnapshotRow | undefined>;
  fetchOpenRouterModels: () => Promise<GatewayModelMap>;
  fetchVercelModels: () => Promise<GatewayModelMap>;
  ttlMs: number;
  nowMs: () => number;
};

/**
 * Provider slugs that serve one exact model variant, derived from the gateway
 * endpoint metadata stored in the metadata cache. Endpoint tags have the shape
 * `<provider-slug>[/<quantization>]`, so their prefix lives in the same slug
 * namespace as provider allow lists and `provider.only` routing.
 */
export function getEndpointProviderSlugs(model: GatewayModelWithEndpoints): Set<string> {
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
  variantModel: GatewayModelWithEndpoints | undefined
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
 * The snapshot providers Kilo's own routes can use. BYOK-only providers serve only an
 * organization's own catalog-mode keys, which are decided per key provider instead (see
 * `isModelAllowedForProviderKey`).
 */
export function getKiloRouteProviders(
  snapshot: NormalizedOpenRouterResponse
): NormalizedOpenRouterResponse['providers'] {
  return snapshot.providers.filter(provider => !provider.byokOnly);
}

export function buildModelIdToProviderSlugsIndex(
  snapshot: NormalizedOpenRouterResponse
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  for (const provider of getKiloRouteProviders(snapshot)) {
    // Snapshot slugs are stored verbatim, so index the canonical slug that
    // provider allow lists and routing ids are compared against.
    const providerSlug = normalizeInferenceProviderId(provider.slug);
    for (const model of provider.models) {
      const normalizedModelId = normalizeModelId(model.slug);
      const existing = index.get(normalizedModelId);

      if (existing) {
        existing.add(providerSlug);
        continue;
      }

      index.set(normalizedModelId, new Set([providerSlug]));
    }
  }

  return index;
}

/**
 * Exact gateway model ids that every snapshot provider may train on. A request
 * that denies data collection has no endpoint to route these to.
 */
export function buildDataCollectionRequiredModelIds(
  snapshot: NormalizedOpenRouterResponse
): Set<string> {
  const trainsOnEveryProvider = new Map<string, boolean>();
  for (const provider of getKiloRouteProviders(snapshot)) {
    for (const model of provider.models) {
      const modelId = getSnapshotModelVariantId(model);
      trainsOnEveryProvider.set(
        modelId,
        (trainsOnEveryProvider.get(modelId) ?? true) &&
          modelTrains(model, provider.dataPolicy.training)
      );
    }
  }
  return new Set(
    [...trainsOnEveryProvider].filter(([, trains]) => trains).map(([modelId]) => modelId)
  );
}

export function createModelsByProviderIndexLoader(options: ProviderIndexLoaderOptions) {
  let cache: ProviderIndexCacheState | undefined;
  let inFlight: Promise<ProviderIndexCacheState> | undefined;

  async function loadState(): Promise<ProviderIndexCacheState> {
    const now = options.nowMs();
    if (cache && cache.expiresAtMs > now) {
      return cache;
    }

    if (inFlight) {
      return await inFlight;
    }

    inFlight = (async (): Promise<ProviderIndexCacheState> => {
      try {
        const snapshot = await options.fetchSnapshot().catch(() => undefined);

        return {
          // A failed read retries on the next call so an empty data-collection
          // set does not stick for the TTL; callers fall back to best-effort checks.
          expiresAtMs: snapshot ? options.nowMs() + options.ttlMs : options.nowMs(),
          snapshotId: snapshot?.id,
          index: snapshot ? buildModelIdToProviderSlugsIndex(snapshot.data) : new Map(),
          dataCollectionRequiredModelIds: snapshot
            ? buildDataCollectionRequiredModelIds(snapshot.data)
            : new Set(),
        };
      } finally {
        inFlight = undefined;
      }
    })();

    cache = await inFlight;
    return cache;
  }

  async function loadIndex(): Promise<ModelIdToProviderSlugsIndex> {
    return (await loadState()).index;
  }

  // A snapshot row never changes, so its index stays valid; only the few snapshots that
  // `disable_new_models` baselines still point at are ever looked up here.
  const indexesBySnapshotId = new Map<number, ModelIdToProviderSlugsIndex>();
  async function loadIndexForSnapshot(
    snapshotId: number
  ): Promise<ModelIdToProviderSlugsIndex | undefined> {
    const cached = indexesBySnapshotId.get(snapshotId);
    if (cached) return cached;
    const snapshot = await options.fetchSnapshotById(snapshotId);
    if (!snapshot) return undefined;
    const index = buildModelIdToProviderSlugsIndex(snapshot.data);
    if (indexesBySnapshotId.size >= MAX_CACHED_BASELINE_INDEXES) {
      const oldest = indexesBySnapshotId.keys().next().value;
      if (oldest !== undefined) indexesBySnapshotId.delete(oldest);
    }
    indexesBySnapshotId.set(snapshotId, index);
    return index;
  }

  /**
   * Whether `modelId` was listed by snapshot `snapshotId` or an older one. A model only a newer
   * snapshot lists has not been reconciled against that baseline yet. An index older than the
   * baseline answers for it, since every model it lists predates the baseline. A missing snapshot
   * answers false.
   */
  async function isModelListedAtOrBefore(snapshotId: number, modelId: string): Promise<boolean> {
    const normalizedModelId = normalizeModelId(modelId);
    const state = await loadState();
    if (state.snapshotId !== undefined && state.snapshotId <= snapshotId) {
      return state.index.has(normalizedModelId);
    }
    return (await loadIndexForSnapshot(snapshotId))?.has(normalizedModelId) ?? false;
  }

  async function getDataCollectionRequiredModelIds(): Promise<ReadonlySet<string>> {
    return (await loadState()).dataCollectionRequiredModelIds;
  }

  async function getProviderSlugsForModels(
    modelIds: readonly string[]
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const modelIdsToResolve = [...new Set(modelIds)];
    const [index, storedModels, vercelModels, vercelIdEntries] = await Promise.all([
      loadIndex(),
      options.fetchOpenRouterModels(),
      options.fetchVercelModels(),
      Promise.all(
        modelIdsToResolve.map(async (modelId): Promise<readonly [string, string]> => {
          return [modelId, await mapModelIdToVercel(modelId)];
        })
      ),
    ]);
    // Every id resolves in the batch above, so the loop body below is synchronous.
    const vercelIdByModel: ReadonlyMap<string, string> = new Map(vercelIdEntries);
    const providersByModel = new Map<string, ReadonlySet<string>>();
    for (const [modelId, vercelModelId] of vercelIdByModel) {
      const snapshotProviderSlugs = index.get(normalizeModelId(modelId));
      if (!snapshotProviderSlugs) {
        providersByModel.set(modelId, new Set());
        continue;
      }
      const openRouterProviderSlugs = narrowProviderSlugsToVariant(
        snapshotProviderSlugs,
        storedModels[modelId]
      );
      const vercelModel = vercelModels[vercelModelId];
      const vercelProviders = new Set(
        vercelModel?.endpoints.map(endpoint =>
          normalizeVercelInferenceProviderIdForRouting(endpoint.provider_name ?? endpoint.tag)
        )
      );
      providersByModel.set(
        modelId,
        new Set(
          [...snapshotProviderSlugs].filter(
            slug =>
              openRouterProviderSlugs.has(slug) ||
              vercelProviders.has(openRouterToVercelInferenceProviderId(slug))
          )
        )
      );
    }
    return providersByModel;
  }

  /**
   * Providers that can serve `modelId`. Accepts variant-suffixed ids such as
   * `x/y:free`; see `narrowProviderSlugsToVariant`.
   */
  async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
    return (await getProviderSlugsForModels([modelId])).get(modelId) ?? new Set();
  }

  return {
    getIndex: loadIndex,
    isModelListedAtOrBefore,
    getProviderSlugsForModel,
    getProviderSlugsForModels,
    getDataCollectionRequiredModelIds,
  };
}

async function fetchLatestModelsByProviderSnapshotRowFromDb(): Promise<
  ModelsByProviderSnapshotRow | undefined
> {
  const result = await readDb
    .select({ id: modelsByProvider.id, data: modelsByProvider.data })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  return result[0];
}

export async function fetchLatestModelsByProviderSnapshotFromDb(): Promise<
  NormalizedOpenRouterResponse | undefined
> {
  return (await fetchLatestModelsByProviderSnapshotRowFromDb())?.data;
}

async function fetchModelsByProviderSnapshotByIdFromDb(
  id: number
): Promise<ModelsByProviderSnapshotRow | undefined> {
  const select = (client: typeof db) =>
    client
      .select({ id: modelsByProvider.id, data: modelsByProvider.data })
      .from(modelsByProvider)
      .where(eq(modelsByProvider.id, id))
      .limit(1);
  // A baseline read from one replica can name a snapshot another replica has not replayed yet.
  // That is rare, so the primary is asked before the request is refused.
  const [row] = await select(readDb);
  if (row) return row;
  return (await select(db))[0];
}

const DEFAULT_TTL_MS = 30_000;
const MAX_CACHED_BASELINE_INDEXES = 4;

const defaultLoader = createModelsByProviderIndexLoader({
  fetchSnapshot: fetchLatestModelsByProviderSnapshotRowFromDb,
  fetchSnapshotById: fetchModelsByProviderSnapshotByIdFromDb,
  fetchOpenRouterModels: getOpenRouterModelsMetadataFromDatabase,
  fetchVercelModels: getVercelModelsMetadataFromDatabase,
  ttlMs: DEFAULT_TTL_MS,
  nowMs: () => Date.now(),
});

export async function getProviderSlugsForModel(modelId: string): Promise<ReadonlySet<string>> {
  return defaultLoader.getProviderSlugsForModel(modelId);
}

export async function getProviderSlugsForModels(
  modelIds: readonly string[]
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  return defaultLoader.getProviderSlugsForModels(modelIds);
}

export async function getModelIdToProviderSlugsIndex(): Promise<ModelIdToProviderSlugsIndex> {
  return defaultLoader.getIndex();
}

export async function getDataCollectionRequiredModelIds(): Promise<ReadonlySet<string>> {
  return defaultLoader.getDataCollectionRequiredModelIds();
}

export async function isModelListedAtOrBefore(
  snapshotId: number,
  modelId: string
): Promise<boolean> {
  return defaultLoader.isModelListedAtOrBefore(snapshotId, modelId);
}
