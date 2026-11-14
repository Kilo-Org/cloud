export type KiloEmbeddingModel = {
  id: string;
  name: string;
  dimension: number;
  scoreThreshold: number;
  note?: string;
  dimensionMode?: 'fixed';
};

export type DiscoveredKiloEmbeddingModel = Omit<KiloEmbeddingModel, 'dimension'> & {
  dimension?: number;
};

export type KiloEmbeddingModelCatalog = {
  defaultModel: string;
  models: DiscoveredKiloEmbeddingModel[];
  aliases: Record<string, string>;
};

export const KILO_DEFAULT_EMBEDDING_MODEL = 'mistralai/mistral-embed-2312';

// Local metadata and request policy, not an availability list. Last checked 2026-11-12 against
// https://openrouter.ai/api/v1/embeddings/models; newly discovered models may lack this metadata.
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
    id: KILO_DEFAULT_EMBEDDING_MODEL,
    name: 'Mistral Embed 2312',
    dimension: 1024,
    scoreThreshold: 0.35,
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
  { id: 'baai/bge-m3', name: 'BAAI bge-m3', dimension: 1024, scoreThreshold: 0.35 },
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
  { id: 'thenlper/gte-large', name: 'GTE Large', dimension: 1024, scoreThreshold: 0.35 },
  { id: 'thenlper/gte-base', name: 'GTE Base', dimension: 768, scoreThreshold: 0.35 },
  { id: 'intfloat/e5-large-v2', name: 'E5 Large v2', dimension: 1024, scoreThreshold: 0.35 },
  { id: 'intfloat/e5-base-v2', name: 'E5 Base v2', dimension: 768, scoreThreshold: 0.35 },
  {
    id: 'intfloat/multilingual-e5-large',
    name: 'Multilingual E5 Large',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'sentence-transformers/all-mpnet-base-v2',
    name: 'all-mpnet-base-v2',
    dimension: 768,
    scoreThreshold: 0.35,
  },
  {
    id: 'sentence-transformers/all-minilm-l12-v2',
    name: 'all-MiniLM-L12-v2',
    dimension: 384,
    scoreThreshold: 0.35,
  },
  {
    id: 'sentence-transformers/all-minilm-l6-v2',
    name: 'all-MiniLM-L6-v2',
    dimension: 384,
    scoreThreshold: 0.35,
  },
  {
    id: 'sentence-transformers/paraphrase-minilm-l6-v2',
    name: 'paraphrase-MiniLM-L6-v2',
    dimension: 384,
    scoreThreshold: 0.35,
  },
  {
    id: 'sentence-transformers/multi-qa-mpnet-base-dot-v1',
    name: 'multi-qa-mpnet-base-dot-v1',
    dimension: 768,
    scoreThreshold: 0.35,
  },
  {
    id: 'cohere/embed-5-fast',
    name: 'Cohere Embed 5 Fast',
    dimension: 2048,
    scoreThreshold: 0.35,
  },
  {
    id: 'cohere/embed-5-pro',
    name: 'Cohere Embed 5 Pro',
    dimension: 2048,
    scoreThreshold: 0.35,
  },
  {
    id: 'amazon/titan-embed-image-v1',
    name: 'Amazon Titan Multimodal Embeddings G1',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'amazon/titan-embed-text-v1',
    name: 'Amazon Titan Embeddings G1 - Text',
    dimension: 1536,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'amazon/titan-embed-text-v2',
    name: 'Amazon Titan Text Embeddings V2',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'nvidia/nemotron-3.5-embed-1b:free',
    name: 'NVIDIA Nemotron 3.5 Embed 1B (free)',
    dimension: 2048,
    scoreThreshold: 0.35,
  },
  {
    id: 'nvidia/nemotron-3.5-embed-8b:free',
    name: 'NVIDIA Nemotron 3.5 Embed 8B (free)',
    dimension: 4096,
    scoreThreshold: 0.35,
  },
  {
    id: 'liquid/lfm-2.5-embedding-350m:free',
    name: 'LiquidAI LFM2.5 Embedding 350M (free)',
    dimension: 1024,
    scoreThreshold: 0.35,
    note: 'Retires 2026-11-13',
    dimensionMode: 'fixed',
  },
  {
    id: 'mongodb/voyage-code-4',
    name: 'Voyage Code 4',
    dimension: 1024,
    scoreThreshold: 0.35,
    note: 'code',
  },
  {
    id: 'mongodb/voyage-multimodal-3.5',
    name: 'Voyage Multimodal 3.5',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'mongodb/voyage-4-lite',
    name: 'Voyage 4 Lite',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'mongodb/voyage-4',
    name: 'Voyage 4',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'mongodb/voyage-4-large',
    name: 'Voyage 4 Large',
    dimension: 1024,
    scoreThreshold: 0.35,
  },
  {
    id: 'nvidia/nemotron-3-embed-1b:free',
    name: 'NVIDIA Nemotron 3 Embed 1B (free)',
    dimension: 2048,
    scoreThreshold: 0.35,
    dimensionMode: 'fixed',
  },
  {
    id: 'google/gemini-embedding-2',
    name: 'Gemini Embedding 2',
    dimension: 3072,
    scoreThreshold: 0.35,
  },
  {
    id: 'google/gemini-embedding-2-preview',
    name: 'Gemini Embedding 2 Preview',
    dimension: 3072,
    scoreThreshold: 0.35,
  },
  {
    id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    name: 'NVIDIA Llama Nemotron Embed VL 1B V2 (free)',
    dimension: 2048,
    scoreThreshold: 0.35,
    note: 'Retires 2026-11-16',
  },
] satisfies KiloEmbeddingModel[];

export const KILO_EMBEDDING_MODEL_ALIASES: Record<string, string> = {
  'text-embedding-3-small': 'openai/text-embedding-3-small',
  'text-embedding-3-large': 'openai/text-embedding-3-large',
  'text-embedding-ada-002': 'openai/text-embedding-ada-002',
  'codestral-embed-2505': 'mistralai/codestral-embed-2505',
  'mistral-embed-2312': KILO_DEFAULT_EMBEDDING_MODEL,
};

// Static local-consumer defaults/policy; gateway discovery uses the stored upstream inventory.
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
