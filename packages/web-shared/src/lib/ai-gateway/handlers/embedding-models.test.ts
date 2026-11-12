import { describe, expect, test } from '@jest/globals';
import { handleEmbeddingModelsRequest } from './embedding-models';
import {
  KILO_DEFAULT_EMBEDDING_MODEL,
  KILO_EMBEDDING_MODEL_CATALOG,
  getKiloEmbeddingModel,
  normalizeKiloEmbeddingModelId,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';

describe('GET /api/gateway/embedding-models', () => {
  test('returns the Kilo embedding model catalog', async () => {
    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(KILO_EMBEDDING_MODEL_CATALOG);
  });

  test('catalog includes default model metadata and aliases', () => {
    expect(KILO_DEFAULT_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(KILO_EMBEDDING_MODEL_CATALOG.defaultModel).toBe('openai/text-embedding-3-small');
    expect(getKiloEmbeddingModel(KILO_DEFAULT_EMBEDDING_MODEL)).toEqual({
      id: 'openai/text-embedding-3-small',
      name: 'OpenAI Text Embedding 3 Small',
      dimension: 1536,
      scoreThreshold: 0.4,
    });
    expect(getKiloEmbeddingModel('codestral-embed-2505')).toMatchObject({
      id: 'mistralai/codestral-embed-2505',
      dimension: 1536,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    });
    expect(normalizeKiloEmbeddingModelId('mistral-embed-2312')).toBe(
      'mistralai/mistral-embed-2312'
    );
    expect(getKiloEmbeddingModel('mistral-embed-2312')).toEqual({
      id: 'mistralai/mistral-embed-2312',
      name: 'Mistral Embed 2312',
      dimension: 1024,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    });
    expect(normalizeKiloEmbeddingModelId('text-embedding-3-small')).toBe(
      'openai/text-embedding-3-small'
    );

    const modelIds = KILO_EMBEDDING_MODEL_CATALOG.models.map(model => model.id);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.filter(id => id === KILO_EMBEDDING_MODEL_CATALOG.defaultModel)).toHaveLength(1);
  });
});
