import * as z from 'zod';
import {
  getKiloEmbeddingModel,
  KILO_DEFAULT_EMBEDDING_MODEL,
  KILO_EMBEDDING_MODEL_ALIASES,
  type KiloEmbeddingModelCatalog,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';
import {
  assertMinimumCount,
  getMetadata,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

const OpenRouterEmbeddingModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  total_count: z.number().int().nonnegative().optional(),
  links: z.object({ next: z.string().nullable().optional() }).optional(),
});

type OpenRouterEmbeddingModels = Pick<z.infer<typeof OpenRouterEmbeddingModelsSchema>, 'data'>;

const EMBEDDING_MODELS_URL = 'https://openrouter.ai/api/v1/embeddings/models';

export const openRouterEmbeddingModelsMetadataSource: MetadataSource<OpenRouterEmbeddingModels> = {
  // Omitting both pagination parameters requests the full inventory, not the default page size.
  url: EMBEDDING_MODELS_URL,
  timeoutMs: 15_000,
  parse: raw => {
    const parsed = OpenRouterEmbeddingModelsSchema.parse(raw);
    assertMinimumCount(EMBEDDING_MODELS_URL, parsed.data.length, 1);
    if (
      parsed.links?.next != null ||
      (parsed.total_count !== undefined && parsed.total_count !== parsed.data.length)
    ) {
      throw new Error('OpenRouter embedding model inventory is truncated');
    }
    if (new Set(parsed.data.map(model => model.id)).size !== parsed.data.length) {
      throw new Error('OpenRouter embedding model inventory contains duplicate IDs');
    }
    return { data: parsed.data };
  },
};

function buildCatalog(stored: OpenRouterEmbeddingModels): KiloEmbeddingModelCatalog {
  const models = stored.data.map(model => {
    const known = getKiloEmbeddingModel(model.id);
    // These are Kilo's local metadata/defaults, never inferred from upstream descriptions or
    // supported_parameters (which do not reliably describe embedding dimension support).
    return { scoreThreshold: 0.35, ...known, id: model.id, name: model.name };
  });
  const modelIds = new Set(models.map(model => model.id));
  const defaultModel = modelIds.has(KILO_DEFAULT_EMBEDDING_MODEL)
    ? KILO_DEFAULT_EMBEDDING_MODEL
    : models[0]?.id;
  if (!defaultModel) throw new Error('OpenRouter embedding model inventory is empty');

  return {
    defaultModel,
    models,
    aliases: Object.fromEntries(
      Object.entries(KILO_EMBEDDING_MODEL_ALIASES).filter(([, id]) => modelIds.has(id))
    ),
  };
}

function createCatalogReader() {
  return createCachedFetch<KiloEmbeddingModelCatalog | null>(
    async () => {
      // Any valid stored snapshot wins, regardless of age. Missing or unusable rows fall back
      // upstream without writing metadata; both sources share this cache's LKG and backoff.
      const metadata = await getMetadata(openRouterEmbeddingModelsMetadataSource, readDb);
      return buildCatalog(metadata);
    },
    300_000,
    null,
    { name: 'openRouterEmbeddingModelCatalog' }
  );
}

let catalogReader = createCatalogReader();

export async function getKiloEmbeddingModelCatalogFromDatabase(): Promise<KiloEmbeddingModelCatalog | null> {
  return catalogReader();
}

export function resetKiloEmbeddingModelCatalogCache() {
  catalogReader = createCatalogReader();
}
