import { describe, expect, it } from '@jest/globals';
import {
  KILO_DEFAULT_EMBEDDING_MODEL,
  KILO_EMBEDDING_MODEL_ALIASES,
  KILO_EMBEDDING_MODELS,
  getKiloEmbeddingModel,
} from './kilo-embedding-models';

const newlyListedModels = [
  ['cohere/embed-5-fast', 2048],
  ['cohere/embed-5-pro', 2048],
  ['amazon/titan-embed-image-v1', 1024],
  ['amazon/titan-embed-text-v1', 1536],
  ['amazon/titan-embed-text-v2', 1024],
  ['nvidia/nemotron-3.5-embed-1b:free', 2048],
  ['nvidia/nemotron-3.5-embed-8b:free', 4096],
  ['liquid/lfm-2.5-embedding-350m:free', 1024],
  ['mongodb/voyage-code-4', 1024],
  ['mongodb/voyage-multimodal-3.5', 1024],
  ['mongodb/voyage-4-lite', 1024],
  ['mongodb/voyage-4', 1024],
  ['mongodb/voyage-4-large', 1024],
  ['nvidia/nemotron-3-embed-1b:free', 2048],
  ['google/gemini-embedding-2', 3072],
  ['google/gemini-embedding-2-preview', 3072],
  ['nvidia/llama-nemotron-embed-vl-1b-v2:free', 2048],
] as const;

const newFixedDimensionModels = [
  ['amazon/titan-embed-text-v1', 1536],
  ['liquid/lfm-2.5-embedding-350m:free', 1024],
  ['nvidia/nemotron-3-embed-1b:free', 2048],
] as const;

describe('Kilo embedding model catalog', () => {
  it.each(newlyListedModels)('includes %s with its default dimensions', (id, dimension) => {
    const model = getKiloEmbeddingModel(id);

    expect(model).toMatchObject({
      id,
      dimension,
      scoreThreshold: 0.35,
    });
    const isFixedDimensionModel = newFixedDimensionModels.some(([fixedId]) => fixedId === id);
    expect(model?.dimensionMode).toBe(isFixedDimensionModel ? 'fixed' : undefined);
  });

  it('has unique model IDs and exactly one default model', () => {
    const modelIds = KILO_EMBEDDING_MODELS.map(model => model.id);

    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.filter(id => id === KILO_DEFAULT_EMBEDDING_MODEL)).toHaveLength(1);
    expect(KILO_DEFAULT_EMBEDDING_MODEL).toBe('mistralai/mistral-embed-2312');
    expect(getKiloEmbeddingModel(KILO_DEFAULT_EMBEDDING_MODEL)).toMatchObject({
      id: 'mistralai/mistral-embed-2312',
      dimension: 1024,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    });
  });

  it('points every alias to an existing catalog model', () => {
    for (const [alias, modelId] of Object.entries(KILO_EMBEDDING_MODEL_ALIASES)) {
      expect(KILO_EMBEDDING_MODELS.some(model => model.id === modelId)).toBe(true);
      expect(getKiloEmbeddingModel(alias)?.id).toBe(modelId);
    }
  });

  it.each(newFixedDimensionModels)('marks %s as fixed at %i dimensions', (id, dimension) => {
    expect(getKiloEmbeddingModel(id)).toMatchObject({
      dimension,
      dimensionMode: 'fixed',
    });
  });

  it('notes listed retirements and the Voyage code model', () => {
    expect(getKiloEmbeddingModel('liquid/lfm-2.5-embedding-350m:free')?.note).toBe(
      'Retires 2026-11-13'
    );
    expect(getKiloEmbeddingModel('nvidia/llama-nemotron-embed-vl-1b-v2:free')?.note).toBe(
      'Retires 2026-11-16'
    );
    expect(getKiloEmbeddingModel('mongodb/voyage-code-4')?.note).toBe('code');
  });
});
