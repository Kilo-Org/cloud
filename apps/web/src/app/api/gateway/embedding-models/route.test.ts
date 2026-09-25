import { describe, expect, test } from '@jest/globals';
import { GET } from './route';
import {
  KILO_DEFAULT_EMBEDDING_MODEL,
  KILO_EMBEDDING_MODEL_CATALOG,
  getKiloEmbeddingModel,
  normalizeKiloEmbeddingModelId,
  resolveDeprecatedKiloEmbeddingModel,
} from '@/lib/ai-gateway/embeddings/kilo-embedding-models';

describe('GET /api/gateway/embedding-models', () => {
  test('returns the Kilo embedding model catalog', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(KILO_EMBEDDING_MODEL_CATALOG);
  });

  test('catalog includes default model metadata and aliases', () => {
    expect(KILO_EMBEDDING_MODEL_CATALOG.defaultModel).toBe(KILO_DEFAULT_EMBEDDING_MODEL);
    expect(KILO_DEFAULT_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(getKiloEmbeddingModel(KILO_DEFAULT_EMBEDDING_MODEL)).toMatchObject({
      id: KILO_DEFAULT_EMBEDDING_MODEL,
      dimension: 1536,
      scoreThreshold: 0.4,
    });
    // The default model supports Matryoshka-style output truncation, so it
    // deliberately does not carry dimensionMode: 'fixed'.
    expect(getKiloEmbeddingModel(KILO_DEFAULT_EMBEDDING_MODEL)?.dimensionMode).toBeUndefined();
    expect(getKiloEmbeddingModel('codestral-embed-2505')).toMatchObject({
      id: 'mistralai/codestral-embed-2505',
      dimension: 1536,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    });
    // Previous default: not Matryoshka-capable, so a stale saved `dimensions`
    // value must be rejected rather than forwarded upstream.
    expect(getKiloEmbeddingModel('sentence-transformers/all-mpnet-base-v2')).toMatchObject({
      dimension: 768,
      dimensionMode: 'fixed',
    });
    expect(normalizeKiloEmbeddingModelId('text-embedding-3-small')).toBe(
      'openai/text-embedding-3-small'
    );
  });

  test('removed mistral-embed-2312 is absent from the catalog and falls back to the default', () => {
    const modelIds = KILO_EMBEDDING_MODEL_CATALOG.models.map(model => model.id);
    expect(modelIds).not.toContain('mistralai/mistral-embed-2312');
    expect(Object.values(KILO_EMBEDDING_MODEL_CATALOG.aliases)).not.toContain(
      'mistralai/mistral-embed-2312'
    );
    expect(resolveDeprecatedKiloEmbeddingModel('mistralai/mistral-embed-2312')).toBe(
      KILO_DEFAULT_EMBEDDING_MODEL
    );
    expect(resolveDeprecatedKiloEmbeddingModel('openai/text-embedding-3-small')).toBe(
      'openai/text-embedding-3-small'
    );
  });
});
