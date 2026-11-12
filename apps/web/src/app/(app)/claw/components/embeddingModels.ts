import { KILO_EMBEDDING_MODELS } from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';

export type EmbeddingModelOption = {
  id: string;
  name: string;
};

export const EMBEDDING_MODELS: EmbeddingModelOption[] = KILO_EMBEDDING_MODELS.map(model => ({
  id: model.id,
  name: model.name,
}));

// Keep nullable legacy configs on the worker/controller default to avoid switching indexed vector spaces on unrelated saves.
export const DEFAULT_EMBEDDING_MODEL = 'mistralai/mistral-embed-2312';
