import { describe, expect, test } from '@jest/globals';
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODELS } from './embeddingModels';

describe('KiloClaw embedding model fallback', () => {
  test('keeps the legacy default available in the catalog', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('mistralai/mistral-embed-2312');
    expect(EMBEDDING_MODELS.some(model => model.id === DEFAULT_EMBEDDING_MODEL)).toBe(true);
  });
});
