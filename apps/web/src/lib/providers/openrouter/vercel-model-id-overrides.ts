import {
  VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT,
  type VercelModelIdOverride,
} from '@kilocode/db/schema-types';
import { mapResolvedModelIdToVercelWithoutOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
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

function indexIdsByCanonicalId(
  entry: unknown,
  availableModelIds: ReadonlySet<string>
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const provider = ModelsDevProviderSchema.safeParse(entry);
  if (!provider.success) return index;

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
    openrouterModelIds
  );
  const vercelByCanonicalId = indexIdsByCanonicalId(
    modelsDevCatalog[MODELS_DEV_VERCEL_PROVIDER],
    vercelModelIds
  );

  const overrides: VercelModelIdOverride[] = [];
  for (const [canonicalId, openrouterModelId] of openrouterByCanonicalId) {
    const vercelModelId = vercelByCanonicalId.get(canonicalId);
    if (!vercelModelId) continue;
    if (openrouterModelId === vercelModelId) continue;
    if (mapResolvedModelIdToVercelWithoutOverrides(openrouterModelId) === vercelModelId) continue;
    overrides.push({ openrouter_model_id: openrouterModelId, vercel_model_id: vercelModelId });
  }

  overrides.sort((a, b) =>
    a.openrouter_model_id < b.openrouter_model_id
      ? -1
      : a.openrouter_model_id > b.openrouter_model_id
        ? 1
        : 0
  );
  if (overrides.length > VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT) {
    console.warn(
      `[vercel-model-id-overrides] dropping ${overrides.length - VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT} overrides beyond the ${VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT} limit`
    );
    return overrides.slice(0, VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT);
  }
  return overrides;
}
