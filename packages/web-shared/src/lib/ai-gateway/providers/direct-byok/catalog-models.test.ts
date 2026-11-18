import { describe, expect, test } from '@jest/globals';
import { getPrimaryCatalogModels, selectPrimaryCatalogModels } from './catalog-models';
import type { DirectByokModel } from './types';

function model(id: string, overrides: Partial<DirectByokModel> = {}): DirectByokModel {
  return { id, name: id, context_length: 4096, max_completion_tokens: 1024, ...overrides };
}

function primaryIds(models: DirectByokModel[]) {
  return Object.fromEntries(
    [...selectPrimaryCatalogModels(models)].map(([catalogId, primary]) => [catalogId, primary.id])
  );
}

describe('selectPrimaryCatalogModels', () => {
  test('prefers the upstream id that names the catalog model over serving-tier variants', () => {
    expect(
      primaryIds([
        model('kimi-k3-fast', { catalog_model_id: 'moonshotai/kimi-k3' }),
        model('kimi-k3-flex', { catalog_model_id: 'moonshotai/kimi-k3', flags: ['recommended'] }),
        model('kimi-k3', { catalog_model_id: 'moonshotai/kimi-k3' }),
        model('hf:zai-org/GLM-5.3-highspeed', { catalog_model_id: 'z-ai/glm-5.3' }),
        model('hf:zai-org/GLM-5.3', { catalog_model_id: 'z-ai/glm-5.3' }),
      ])
    ).toEqual({ 'moonshotai/kimi-k3': 'kimi-k3', 'z-ai/glm-5.3': 'hf:zai-org/GLM-5.3' });
  });

  test('falls back to a recommended model, then the shortest upstream id', () => {
    expect(
      primaryIds([
        model('moonshotai/Kimi-K2.6-TEE-long', { catalog_model_id: 'moonshotai/kimi-k2.6' }),
        model('moonshotai/Kimi-K2.6-TEE-recommended', {
          catalog_model_id: 'moonshotai/kimi-k2.6',
          flags: ['recommended'],
        }),
        model('glm-turbo-preview', { catalog_model_id: 'z-ai/glm-5.2' }),
        model('glm-turbo', { catalog_model_id: 'z-ai/glm-5.2' }),
        model('unmapped'),
      ])
    ).toEqual({
      'moonshotai/kimi-k2.6': 'moonshotai/Kimi-K2.6-TEE-recommended',
      'z-ai/glm-5.2': 'glm-turbo',
    });
  });

  test('derives the map once per cached model list', () => {
    const models = [model('glm-5.2', { catalog_model_id: 'z-ai/glm-5.2' })];

    expect(getPrimaryCatalogModels(models)).toBe(getPrimaryCatalogModels(models));
    expect(getPrimaryCatalogModels([...models])).not.toBe(getPrimaryCatalogModels(models));
  });
});
