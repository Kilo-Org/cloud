export type KiloEmbeddingModel = {
  id: string;
  name: string;
  dimension: number;
  scoreThreshold: number;
  note?: string;
  dimensionMode?: 'fixed';
};

export type KiloEmbeddingModelCatalog = {
  defaultModel: string;
  models: KiloEmbeddingModel[];
  aliases: Record<string, string>;
};

// Chosen over sentence-transformers/all-mpnet-base-v2 (previous default): OpenAI is
// served through two independent, high-uptime OpenRouter endpoints (Azure + OpenAI
// direct, ~100%/99.9% 1-day uptime as of 2026-09-24) versus a single DeepInfra route
// for the sentence-transformers model, it natively supports variable-dimension
// (Matryoshka) output so `dimensions` requests are legitimately forwarded rather than
// silently mismatched, and at $0.02/M tokens it remains inexpensive while offering
// materially better retrieval quality for code/semantic search than the 2021-era
// all-mpnet-base-v2 model. See PR discussion for the full model-by-model evaluation.
export const KILO_DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export const KILO_EMBEDDING_MODELS = [
  {
    id: 'mistralai/codestral-embed-2505',
    name: 'Codestral Embed 2505',
    dimension: 1536,
    scoreThreshold: 0.35,
    note: 'code',
    dimensionMode: 'fixed',
  },
  {
    id: 'openai/text-embedding-3-small',
    name: 'OpenAI Text Embedding 3 Small',
    dimension: 1536,
    scoreThreshold: 0.4,
  },
  {
    id: 'openai/text-embedding-3-large',
    name: 'OpenAI Text Embedding 3 Large',
    dimension: 3072,
    scoreThreshold: 0.4,
  },
  {
    id: 'openai/text-embedding-ada-002',
    name: 'OpenAI Text Embedding Ada 002',
    dimension: 1536,
    scoreThreshold: 0.4,
    dimensionMode: 'fixed',
  },
  {
    id: 'google/gemini-embedding-001',
    name: 'Gemini Embedding 001',
    dimension: 3072,
    scoreThreshold: 0.35,
  },
  {
    id: 'qwen/qwen3-embedding-8b',
    name: 'Qwen3 Embedding 8B',
    dimension: 4096,
    scoreThreshold: 0.35,
  },
  {
    id: 'qwen/qwen3-embedding-4b',
    name: 'Qwen3 Embedding 4B',
    dimension: 2560,
    scoreThreshold: 0.35,
  },
  {
    id: 'perplexity/pplx-embed-v1-4b',
    name: 'Perplexity Embed V1 4B',
    dimension: 2560,
    scoreThreshold: 0.35,
  },
  {
    id: 'perplexity/pplx-embed-v1-0.6b',
    name: 'Perplexity Embed V1 0.6B',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'baai/bge-m3',
    name: 'BAAI bge-m3',
    dimension: 1024,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'baai/bge-large-en-v1.5',
    name: 'BAAI bge-large-en-v1.5',
    dimension: 1024,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'baai/bge-base-en-v1.5',
    name: 'BAAI bge-base-en-v1.5',
    dimension: 768,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'thenlper/gte-large',
    name: 'GTE Large',
    dimension: 1024,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'thenlper/gte-base',
    name: 'GTE Base',
    dimension: 768,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'intfloat/e5-large-v2',
    name: 'E5 Large v2',
    dimension: 1024,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'intfloat/e5-base-v2',
    name: 'E5 Base v2',
    dimension: 768,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'intfloat/multilingual-e5-large',
    name: 'Multilingual E5 Large',
    dimension: 1024,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    // Previous KILO_DEFAULT_EMBEDDING_MODEL. Not Matryoshka-capable: a stale
    // `dimensions` value from a client that saved this model must be rejected
    // (validateEmbeddingDimensions), not silently forwarded upstream.
    id: 'sentence-transformers/all-mpnet-base-v2',
    name: 'all-mpnet-base-v2',
    dimension: 768,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'sentence-transformers/all-minilm-l12-v2',
    name: 'all-MiniLM-L12-v2',
    dimension: 384,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'sentence-transformers/all-minilm-l6-v2',
    name: 'all-MiniLM-L6-v2',
    dimension: 384,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'sentence-transformers/paraphrase-minilm-l6-v2',
    name: 'paraphrase-MiniLM-L6-v2',
    dimension: 384,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'sentence-transformers/multi-qa-mpnet-base-dot-v1',
    name: 'multi-qa-mpnet-base-dot-v1',
    dimension: 768,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
] satisfies KiloEmbeddingModel[];

export const KILO_EMBEDDING_MODEL_ALIASES: Record<string, string> = {
  'text-embedding-3-small': 'openai/text-embedding-3-small',
  'text-embedding-3-large': 'openai/text-embedding-3-large',
  'text-embedding-ada-002': 'openai/text-embedding-ada-002',
  'codestral-embed-2505': 'mistralai/codestral-embed-2505',
};

// Removed from the catalog after OpenRouter dropped the model; rewrite requests
// from clients that still have it saved so they keep working on the default.
//
// Note: `mistralai/codestral-embed-2505` was suspected dead in a prior
// investigation, but that check queried `GET /api/v1/models`, which never lists
// *any* embedding-only model (OpenRouter excludes embeddings entirely from that
// endpoint). The authoritative source, `GET /api/v1/embeddings/models` (and its
// per-model `/endpoints` detail), shows `codestral-embed-2505` with three live
// Mistral-served endpoints and ~100% uptime, so it stays in the catalog as a
// non-deprecated, working model.
export const KILO_DEPRECATED_EMBEDDING_MODEL_FALLBACKS: Record<string, string> = {
  'mistralai/mistral-embed-2312': KILO_DEFAULT_EMBEDDING_MODEL,
};

export function resolveDeprecatedKiloEmbeddingModel(modelId: string): string {
  return KILO_DEPRECATED_EMBEDDING_MODEL_FALLBACKS[modelId] ?? modelId;
}

export const KILO_EMBEDDING_MODEL_CATALOG = {
  defaultModel: KILO_DEFAULT_EMBEDDING_MODEL,
  models: KILO_EMBEDDING_MODELS,
  aliases: KILO_EMBEDDING_MODEL_ALIASES,
} satisfies KiloEmbeddingModelCatalog;

export function normalizeKiloEmbeddingModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return KILO_EMBEDDING_MODEL_ALIASES[modelId] ?? modelId;
}

export function getKiloEmbeddingModel(modelId: string | undefined): KiloEmbeddingModel | undefined {
  const id = normalizeKiloEmbeddingModelId(modelId);
  return KILO_EMBEDDING_MODELS.find(model => model.id === id);
}
