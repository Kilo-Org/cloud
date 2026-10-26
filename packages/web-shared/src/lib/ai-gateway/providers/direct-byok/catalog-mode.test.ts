import { beforeEach, describe, expect, test } from '@jest/globals';
import type * as DirectByokTypes from './types';
import type { EnabledByokProvider } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getEnabledByokProviders } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  createDirectByokReferenceResolver,
  defaultsToCatalogMode,
  findDirectByokCatalogModels,
  getDirectByokCatalogModelIds,
  getDirectByokModelsForUser,
  supportsCatalogMode,
} from './index';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: {} }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  getEnabledByokProviders: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  isValidOpenRouterModelId: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/preferred-models', () => ({
  getPreferredModels: jest.fn(async () => []),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/model-settings', () => ({
  getAiSdkProvider: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => ({
  isKiloExclusiveModel: (modelId: string) => modelId === 'stealth/exclusive',
}));

function mockProvider(
  id: string,
  models_dev_id: string | undefined,
  models: ReadonlyArray<DirectByokTypes.DirectByokModel>
) {
  return {
    id,
    models_dev_id,
    models: async () => models,
    transformRequest: () => {},
    resolveUpstream: jest.requireActual<typeof DirectByokTypes>('./types').apiKeyUpstream({
      apiUrl: `https://${id}.example.com/v1`,
      supportedChatApis: ['chat_completions'],
      responseTransforms: null,
    }),
  };
}

function mockModel(id: string, catalog_model_id?: string): DirectByokTypes.DirectByokModel {
  return { id, name: id, context_length: 4096, max_completion_tokens: 1024, catalog_model_id };
}

jest.mock('./direct-byok-definitions', () => ({
  __esModule: true,
  default: [
    mockProvider('synthetic', 'synthetic', [
      mockModel('hf:moonshotai/Kimi-K2.6', 'moonshotai/kimi-k2.6'),
      mockModel('hf:moonshotai/Kimi-K2.6-fast', 'moonshotai/kimi-k2.6'),
      mockModel('hf:example/finetune'),
      mockModel('hf:stealth/exclusive', 'stealth/exclusive'),
    ]),
    mockProvider('zai-coding', 'zai-coding-plan', [
      mockModel('glm-5.2', 'z-ai/glm-5.2'),
      mockModel('kimi-k2.6', 'moonshotai/kimi-k2.6'),
    ]),
    mockProvider('martian', undefined, [mockModel('moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.6')]),
    mockProvider('morph-byok', 'morph', [mockModel('morph-v3-fast')]),
  ],
}));

const mockedKeys = jest.mocked(getEnabledByokProviders);
const mockedIsValid = jest.mocked(isValidOpenRouterModelId);

function keys(entries: Record<string, boolean>): EnabledByokProvider[] {
  return Object.entries(entries).map(([providerId, serveCatalogModels]) => ({
    providerId: providerId as EnabledByokProvider['providerId'],
    serveCatalogModels,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedIsValid.mockImplementation(async modelId => modelId !== 'moonshotai/retired');
});

describe('catalog mode support', () => {
  test('requires a models.dev id, and defaults on only when the provider maps a model', async () => {
    expect(supportsCatalogMode('synthetic')).toBe(true);
    expect(supportsCatalogMode('martian')).toBe(false);
    await expect(defaultsToCatalogMode('synthetic')).resolves.toBe(true);
    await expect(defaultsToCatalogMode('morph-byok')).resolves.toBe(false);
    await expect(defaultsToCatalogMode('martian')).resolves.toBe(false);
  });
});

describe('direct BYOK model lists in catalog mode', () => {
  test('omits bespoke entries of catalog-mode keys', async () => {
    mockedKeys.mockResolvedValueOnce(keys({ synthetic: true, 'zai-coding': false, martian: true }));

    const models = await getDirectByokModelsForUser('user-id');

    expect(models.map(entry => entry.id)).toEqual([
      'zai-coding/glm-5.2',
      'zai-coding/kimi-k2.6',
      'martian/moonshotai/kimi-k2.6',
    ]);
  });

  test('lists catalog ids served by catalog-mode keys only', async () => {
    mockedKeys.mockResolvedValueOnce(keys({ synthetic: true, 'zai-coding': false, martian: true }));

    const catalogIds = await getDirectByokCatalogModelIds({ type: 'user', id: 'user-id' });

    expect([...catalogIds]).toEqual(['moonshotai/kimi-k2.6']);
  });
});

describe('findDirectByokCatalogModels', () => {
  test('returns the primary model of each supporting provider in provider order', async () => {
    const found = await findDirectByokCatalogModels('moonshotai/kimi-k2.6');

    expect(found.map(({ provider, model }) => [provider.id, model.id])).toEqual([
      ['synthetic', 'hf:moonshotai/Kimi-K2.6'],
      ['zai-coding', 'kimi-k2.6'],
    ]);
  });

  test('ignores unmapped, Kilo-exclusive and retired catalog ids', async () => {
    await expect(findDirectByokCatalogModels('example/unknown')).resolves.toEqual([]);
    await expect(findDirectByokCatalogModels('stealth/exclusive')).resolves.toEqual([]);
    mockedIsValid.mockResolvedValueOnce(false);
    await expect(findDirectByokCatalogModels('z-ai/glm-5.2')).resolves.toEqual([]);
  });
});

describe('createDirectByokReferenceResolver', () => {
  test('translates bespoke ids of catalog-mode keys and leaves other ids unchanged', async () => {
    mockedKeys.mockResolvedValueOnce(keys({ synthetic: true, 'zai-coding': false }));
    const resolve = await createDirectByokReferenceResolver({ type: 'organization', id: 'org' });

    await expect(resolve('synthetic/hf:moonshotai/kimi-k2.6-fast')).resolves.toBe(
      'moonshotai/kimi-k2.6'
    );
    await expect(resolve('synthetic/hf:example/finetune')).resolves.toBeNull();
    await expect(resolve('zai-coding/glm-5.2')).resolves.toBe('zai-coding/glm-5.2');
    await expect(resolve('openai/gpt-5')).resolves.toBe('openai/gpt-5');
    expect(mockedKeys).toHaveBeenCalledWith(expect.anything(), { type: 'organization', id: 'org' });
  });
});
