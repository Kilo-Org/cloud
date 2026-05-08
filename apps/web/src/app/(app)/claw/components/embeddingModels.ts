import {
  KILO_DEFAULT_EMBEDDING_MODEL,
  KILO_EMBEDDING_MODELS,
} from '@/lib/ai-gateway/embeddings/kilo-embedding-models';

export type EmbeddingModelOption = {
  id: string;
  name: string;
};

export const EMBEDDING_MODELS: EmbeddingModelOption[] = KILO_EMBEDDING_MODELS.map(model => ({
  id: model.id,
  name: model.name,
}));

export const DEFAULT_EMBEDDING_MODEL = KILO_DEFAULT_EMBEDDING_MODEL;
