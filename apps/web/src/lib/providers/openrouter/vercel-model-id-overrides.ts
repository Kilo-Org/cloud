import {
  VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT,
  type VercelModelIdOverride,
} from '@kilocode/db/schema-types';
import { mapResolvedModelIdToVercelWithoutOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { LEGACY_OPENROUTER_MODEL_ID_OVERRIDES } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';
import {
  ModelsDevProviderSchema,
  type ModelsDevCatalog,
} from '@/lib/providers/direct-byok/models-dev';

const MODELS_DEV_OPENROUTER_PROVIDER = 'openrouter';
const MODELS_DEV_VERCEL_PROVIDER = 'vercel';

function isFreeVariant(modelId: string) {
  return modelId.endsWith(':free') || modelId.endsWith('-free');
}

function preferredModelId(current: string | undefined, candidate: string): string {
  if (!current) return candidate;
  if (candidate.length !== current.length) {
    return candidate.length < current.length ? candidate : current;
  }
  return candidate < current ? candidate : current;
}

function compareByOpenRouterModelId(a: VercelModelIdOverride, b: VercelModelIdOverride): number {
  return a.openrouter_model_id < b.openrouter_model_id
    ? -1
    : a.openrouter_model_id > b.openrouter_model_id
      ? 1
      : 0;
}

function indexIdsByCanonicalId(
  entry: unknown,
  providerId: string,
  availableModelIds: ReadonlySet<string>
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const provider = ModelsDevProviderSchema.safeParse(entry);
  if (!provider.success) {
    throw new Error(`models.dev catalog is missing a valid ${providerId} provider entry`);
  }

  for (const model of Object.values(provider.data.models)) {
    if (!model.canonical_model_id) continue;
    if (isFreeVariant(model.id)) continue;
    if (!availableModelIds.has(model.id)) continue;
    index.set(
      model.canonical_model_id,
      preferredModelId(index.get(model.canonical_model_id), model.id)
    );
  }
  return index;
}

export function buildVercelModelIdOverrides(params: {
  modelsDevCatalog: ModelsDevCatalog;
  openrouterModelIds: ReadonlySet<string>;
  vercelModelIds: ReadonlySet<string>;
}): VercelModelIdOverride[] {
  const { modelsDevCatalog, openrouterModelIds, vercelModelIds } = params;
  const openrouterByCanonicalId = indexIdsByCanonicalId(
    modelsDevCatalog[MODELS_DEV_OPENROUTER_PROVIDER],
    MODELS_DEV_OPENROUTER_PROVIDER,
    openrouterModelIds
  );
  const vercelByCanonicalId = indexIdsByCanonicalId(
    modelsDevCatalog[MODELS_DEV_VERCEL_PROVIDER],
    MODELS_DEV_VERCEL_PROVIDER,
    vercelModelIds
  );

  const legacyOverrides = Object.entries(LEGACY_OPENROUTER_MODEL_ID_OVERRIDES).flatMap(
    ([openrouter_model_id, vercel_model_id]) => {
      if (openrouter_model_id === vercel_model_id) return [];
      if (mapResolvedModelIdToVercelWithoutOverrides(openrouter_model_id) === vercel_model_id) {
        return [];
      }
      return [{ openrouter_model_id, vercel_model_id }];
    }
  );
  const legacyOpenRouterModelIds = new Set(Object.keys(LEGACY_OPENROUTER_MODEL_ID_OVERRIDES));

  const generatedOverrides: VercelModelIdOverride[] = [];
  for (const [canonicalId, openrouterModelId] of openrouterByCanonicalId) {
    const vercelModelId = vercelByCanonicalId.get(canonicalId);
    if (!vercelModelId) continue;
    if (openrouterModelId === vercelModelId) continue;
    if (mapResolvedModelIdToVercelWithoutOverrides(openrouterModelId) === vercelModelId) continue;
    if (legacyOpenRouterModelIds.has(openrouterModelId)) continue;
    generatedOverrides.push({
      openrouter_model_id: openrouterModelId,
      vercel_model_id: vercelModelId,
    });
  }
  generatedOverrides.sort(compareByOpenRouterModelId);

  const generatedCapacity = Math.max(
    0,
    VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT - legacyOverrides.length
  );
  if (generatedOverrides.length > generatedCapacity) {
    console.warn(
      `[vercel-model-id-overrides] dropping ${generatedOverrides.length - generatedCapacity} overrides beyond the ${VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT} limit`
    );
    generatedOverrides.length = generatedCapacity;
  }

  return [...legacyOverrides, ...generatedOverrides].sort(compareByOpenRouterModelId);
}
