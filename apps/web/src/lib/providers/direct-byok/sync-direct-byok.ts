import * as z from 'zod';
import type {
  DirectByokModel,
  DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import DIRECT_BYOK_PROVIDERS from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import type { DirectUserByokInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { direct_byok_model_lists } from '@kilocode/db/schema';
import {
  assertMinimumCount,
  getMetadata,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import {
  ModalitySchema,
  ModelsDevProviderSchema,
  loadModelsDevCatalog,
  modelsDevCatalogSource,
  isUsableModelsDevModel,
  shortenDisplayName,
  toRawModel,
  type ModelsDevCatalog,
  type ModelsDevProvider,
  type RawModel,
} from './models-dev';
import { parseAwsBedrockModelsDevModels } from './bedrock-models';
import { parseGcpVertexModelsDevModels } from './vertex-models';
import { recordSyncCompleted } from '@/lib/providers/openrouter/sync-providers-stale-alert';

const DEFAULT_CONTENT_LENGTH = 200_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;

const OpenAICompatibleModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      max_model_len: z.number().optional(),
      max_output_length: z.number().optional(),
      input_modalities: z.array(ModalitySchema).optional(),
      supported_features: z.array(z.string()).optional(),
    })
  ),
});

type OpenAICompatibleModelsResponse = z.infer<typeof OpenAICompatibleModelsResponseSchema>;

function openAICompatibleModelsSource(url: string): MetadataSource<OpenAICompatibleModelsResponse> {
  return {
    url,
    parse: raw => {
      const parsed = OpenAICompatibleModelsResponseSchema.parse(raw);
      assertMinimumCount(url, parsed.data.length, 1);
      return parsed;
    },
  };
}

// A models.dev per-model `provider.npm` names the SDK for the model's own endpoint. Several SDK
// names, such as `@ai-sdk/mistral`, still speak Chat Completions, so only SDKs for the native
// Gemini API, which the gateway cannot proxy, are excluded.
const GEMINI_API_MODELS_DEV_SDKS: ReadonlySet<string> = new Set([
  '@ai-sdk/google',
  '@ai-sdk/google-vertex',
]);

const MODELS_DEV_OPENROUTER_ID = 'openrouter';

type SyncContext = {
  getModelsDevCatalog(): Promise<ModelsDevCatalog>;
  getCatalogModelIdsByCanonicalId(): Promise<ReadonlyMap<string, string>>;
};

type ProviderFetcher = {
  providerId: DirectUserByokInferenceProviderId;
  metadataSources: ReadonlyArray<MetadataSource<unknown>>;
  fetch(ctx: SyncContext): Promise<RawModel[]>;
};

function openAICompatibleFetcher(options: {
  providerId: DirectUserByokInferenceProviderId;
  url: string;
}): ProviderFetcher {
  const metadataSource = openAICompatibleModelsSource(options.url);
  return {
    providerId: options.providerId,
    metadataSources: [metadataSource],
    async fetch() {
      return toOpenAICompatibleRawModels(await getMetadata(metadataSource, readDb));
    },
  };
}

export function parseOpenAICompatibleProviderModels(entry: unknown): RawModel[] {
  return toOpenAICompatibleRawModels(OpenAICompatibleModelsResponseSchema.parse(entry));
}

function toOpenAICompatibleRawModels(parsed: OpenAICompatibleModelsResponse): RawModel[] {
  return parsed.data
    .filter(model => !model.supported_features || model.supported_features.includes('tools'))
    .map(model => ({
      id: model.id,
      name: shortenDisplayName(model.name),
      context_length: model.context_length ?? model.max_model_len,
      max_completion_tokens: model.max_output_length,
      input_modalities: model.input_modalities,
      flags: ['reasoning'],
    }));
}

export function parseModelsDevProviderModels(
  entry: unknown,
  providerId: DirectUserByokInferenceProviderId,
  availableModelIds?: ReadonlySet<string>
): RawModel[] {
  const provider = ModelsDevProviderSchema.parse(entry);
  return Object.values(provider.models)
    .filter(
      model =>
        isUsableModelsDevModel(model) &&
        (!availableModelIds || availableModelIds.has(model.id)) &&
        (!model.provider?.npm || !GEMINI_API_MODELS_DEV_SDKS.has(model.provider.npm))
    )
    .map(model => toRawModel(model));
}

function getModelsDevId(providerId: DirectUserByokInferenceProviderId): string | undefined {
  const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;
  return providers.find(provider => provider.id === providerId)?.models_dev_id;
}

function isPreferredCatalogModelId(candidate: string, current: string, canonicalId: string) {
  if (current === canonicalId) return false;
  return candidate === canonicalId || candidate.length < current.length;
}

// models.dev keys its `openrouter` provider by OpenRouter model ID, so its canonical IDs translate
// the models.dev vendor namespace (`zhipuai/glm-5.2`) into the catalog's (`z-ai/glm-5.2`).
export function indexCatalogModelIdsByCanonicalId(
  catalog: ModelsDevCatalog
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const entry = catalog[MODELS_DEV_OPENROUTER_ID];
  if (!entry) {
    console.warn('[sync-direct-byok-providers] models.dev catalog missing openrouter entry');
    return index;
  }
  for (const model of Object.values(ModelsDevProviderSchema.parse(entry).models)) {
    const canonicalId = model.canonical_model_id;
    // Variants such as `:free` are routing options of a catalog model, not separate models.
    if (!canonicalId || model.id.includes(':')) continue;
    const current = index.get(canonicalId);
    if (!current || isPreferredCatalogModelId(model.id, current, canonicalId)) {
      index.set(canonicalId, model.id);
    }
  }
  return index;
}

async function getCatalogModelIds(
  providerId: DirectUserByokInferenceProviderId,
  ctx: SyncContext
): Promise<ReadonlyMap<string, string>> {
  const catalogModelIds = new Map<string, string>();
  const modelsDevId = getModelsDevId(providerId);
  if (!modelsDevId) return catalogModelIds;
  const entry = (await ctx.getModelsDevCatalog())[modelsDevId];
  if (!entry) return catalogModelIds;
  const byCanonicalId = await ctx.getCatalogModelIdsByCanonicalId();
  for (const model of Object.values(ModelsDevProviderSchema.parse(entry).models)) {
    const catalogModelId = model.canonical_model_id && byCanonicalId.get(model.canonical_model_id);
    if (catalogModelId) catalogModelIds.set(model.id, catalogModelId);
  }
  return catalogModelIds;
}

function getModelsDevEntry(
  providerId: DirectUserByokInferenceProviderId,
  catalog: ModelsDevCatalog
) {
  const catalogKey = getModelsDevId(providerId);
  if (!catalogKey) {
    throw new Error(`${providerId} has no models.dev ID`);
  }
  const entry = catalog[catalogKey];
  if (!entry) {
    throw new Error(`models.dev catalog missing ${catalogKey} entry`);
  }
  return entry;
}

/** Parses a provider's models.dev entry with a provider-specific selection. */
function customModelsDevFetcher(
  providerId: DirectUserByokInferenceProviderId,
  parse: (provider: ModelsDevProvider) => RawModel[]
): ProviderFetcher {
  return {
    providerId,
    metadataSources: [modelsDevCatalogSource],
    async fetch(ctx) {
      const entry = getModelsDevEntry(providerId, await ctx.getModelsDevCatalog());
      return parse(ModelsDevProviderSchema.parse(entry));
    },
  };
}

function modelsDevFetcher(
  providerId: DirectUserByokInferenceProviderId,
  availableModelsUrl?: string
): ProviderFetcher {
  const metadataSource = availableModelsUrl
    ? openAICompatibleModelsSource(availableModelsUrl)
    : undefined;
  return {
    providerId,
    metadataSources: metadataSource
      ? [modelsDevCatalogSource, metadataSource]
      : [modelsDevCatalogSource],
    async fetch(ctx) {
      const entry = getModelsDevEntry(providerId, await ctx.getModelsDevCatalog());
      if (!metadataSource) {
        return parseModelsDevProviderModels(entry, providerId);
      }
      const availableModels = await getMetadata(metadataSource, readDb);
      const availableModelIds = new Set(availableModels.data.map(model => model.id));
      return parseModelsDevProviderModels(entry, providerId, availableModelIds);
    },
  };
}

const FETCHERS: ReadonlyArray<ProviderFetcher> = [
  openAICompatibleFetcher({
    providerId: 'neuralwatt',
    url: 'https://api.neuralwatt.com/v1/models',
  }),
  modelsDevFetcher('nvidia-byok', 'https://integrate.api.nvidia.com/v1/models'),
  openAICompatibleFetcher({
    providerId: 'chutes-byok',
    url: 'https://llm.chutes.ai/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'orcarouter',
    url: 'https://api.orcarouter.ai/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'inceptron-byok',
    url: 'https://api.inceptron.io/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'martian',
    url: 'https://api.withmartian.com/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'synthetic',
    url: 'https://api.synthetic.new/v1/models',
  }),
  openAICompatibleFetcher({
    providerId: 'morph-byok',
    url: 'https://www.morphllm.com/api/models/json',
  }),
  modelsDevFetcher('alibaba-token-plan'),
  modelsDevFetcher('edenai', 'https://api.edenai.run/v3/models'),
  modelsDevFetcher('zai-coding'),
  modelsDevFetcher('ollama-cloud', 'https://ollama.com/v1/models'),
  modelsDevFetcher('opencode-go', 'https://opencode.ai/zen/go/v1/models'),
  modelsDevFetcher('xiaomi-token-plan-ams'),
  modelsDevFetcher('xiaomi-token-plan-sgp'),
  customModelsDevFetcher('bedrock-byok', parseAwsBedrockModelsDevModels),
  customModelsDevFetcher('vertex-byok', parseGcpVertexModelsDevModels),
];

export const directByokMetadataSources: ReadonlyArray<MetadataSource<unknown>> = [
  ...new Map(
    FETCHERS.flatMap(fetcher => fetcher.metadataSources).map(source => [source.url, source])
  ).values(),
];

async function syncProvider(fetcher: ProviderFetcher, ctx: SyncContext): Promise<number> {
  const [fetched, catalogModelIds] = await Promise.all([
    fetcher.fetch(ctx),
    getCatalogModelIds(fetcher.providerId, ctx),
  ]);
  const models: DirectByokModel[] = [];

  for (const raw of fetched) {
    const name = raw.name ?? shortenDisplayName(raw.id);
    const context_length = raw.context_length ?? DEFAULT_CONTENT_LENGTH;
    const flags = new Set(raw.flags);
    if (raw.input_modalities?.includes('image')) flags.add('vision');
    const max_completion_tokens = Math.min(
      raw.max_completion_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      context_length
    );
    models.push({
      id: raw.id,
      name,
      flags: flags.size > 0 ? [...flags] : undefined,
      context_length,
      max_completion_tokens,
      reasoning_options: raw.reasoning_options,
      catalog_model_id: catalogModelIds.get(raw.id),
      ...(raw.endpoint && { endpoint: raw.endpoint }),
    });
  }

  const synced_at = new Date().toISOString();
  await db
    .insert(direct_byok_model_lists)
    .values({ provider_id: fetcher.providerId, models, synced_at })
    .onConflictDoUpdate({
      target: direct_byok_model_lists.provider_id,
      set: { models, synced_at },
    });

  return models.length;
}

export async function syncDirectByokModels(): Promise<
  Partial<Record<DirectUserByokInferenceProviderId, number>>
> {
  let catalogPromise: Promise<ModelsDevCatalog> | null = null;
  let catalogModelIdsPromise: Promise<ReadonlyMap<string, string>> | null = null;
  const getModelsDevCatalog = () => (catalogPromise ??= loadModelsDevCatalog());
  const ctx: SyncContext = {
    getModelsDevCatalog,
    getCatalogModelIdsByCanonicalId() {
      catalogModelIdsPromise ??= getModelsDevCatalog().then(indexCatalogModelIdsByCanonicalId);
      return catalogModelIdsPromise;
    },
  };
  const entries = await Promise.all(
    FETCHERS.map(async fetcher => [fetcher.providerId, await syncProvider(fetcher, ctx)] as const)
  );
  return Object.fromEntries(entries);
}

export async function syncAndStoreDirectByokProviders() {
  const startTime = performance.now();
  const direct_byok_model_counts = await syncDirectByokModels();
  console.log('[sync-direct-byok-providers] model counts:', direct_byok_model_counts);
  const completed_at = await recordSyncCompleted('direct_byok');
  const counts = Object.values(direct_byok_model_counts);
  return {
    completed_at,
    total_providers: counts.length,
    total_models: counts.reduce((sum, count) => sum + count, 0),
    direct_byok_model_counts,
    time: performance.now() - startTime,
  };
}
