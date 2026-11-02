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

/** Legacy OpenRouter IDs that never appear in the OpenRouter or models.dev catalog. */
export const LEGACY_OPENROUTER_MODEL_ID_OVERRIDES: Readonly<Record<string, string>> = {
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-5-20260630': 'anthropic/claude-sonnet-5',
  'claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'minimax-m3': 'minimax/minimax-m3',
  'minimax/minimax-m2.5-20260211': 'minimax/minimax-m2.5',
};

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

  const legacyOverrides = Object.entries(LEGACY_OPENROUTER_MODEL_ID_OVERRIDES).map(
    ([openrouter_model_id, vercel_model_id]) => ({ openrouter_model_id, vercel_model_id })
  );
  const legacyOpenRouterModelIds = new Set(
    legacyOverrides.map(override => override.openrouter_model_id)
  );

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

  const generatedCapacity = VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT - legacyOverrides.length;
  if (generatedOverrides.length > generatedCapacity) {
    console.warn(
      `[vercel-model-id-overrides] dropping ${generatedOverrides.length - generatedCapacity} overrides beyond the ${VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT} limit`
    );
    generatedOverrides.length = generatedCapacity;
  }

  return [...legacyOverrides, ...generatedOverrides].sort(compareByOpenRouterModelId);
}
