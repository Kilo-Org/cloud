import { beforeEach, describe, expect, test } from '@jest/globals';
import type * as DirectByokTypes from './types';
import type { EnabledByokProvider } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getEnabledByokProviders } from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  getOpenRouterModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  createDirectByokReferenceResolver,
  listDirectByokCatalogModels,
  offersCatalogMode,
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
  resolveOpenRouterModelAlias: jest.fn(),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
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
  models: ReadonlyArray<DirectByokTypes.DirectByokModel>,
  openrouter_inference_provider_id?: string
) {
  return {
    id,
    models_dev_id,
    openrouter_inference_provider_id,
    models: async () => models,
    transformRequest: () => {},
    ...jest.requireActual<typeof DirectByokTypes>('./types').apiKeyUpstream({
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
      mockModel('hf:moonshotai/retired', 'moonshotai/retired'),
    ]),
    mockProvider(
      'zai-coding',
      'zai-coding-plan',
      [mockModel('glm-5.2', 'z-ai/glm-5.2'), mockModel('kimi-k2.6', 'moonshotai/kimi-k2.6')],
      'z-ai'
    ),
    mockProvider('martian', undefined, [mockModel('moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.6')]),
    mockProvider('morph-byok', 'morph', [mockModel('morph-v3-fast')]),
    mockProvider('chutes-byok', 'chutes', [mockModel('moonshotai/retired', 'moonshotai/retired')]),
  ],
}));

const mockedKeys = jest.mocked(getEnabledByokProviders);
const mockedIsValid = jest.mocked(isValidOpenRouterModelId);
const mockedResolveAlias = jest.mocked(resolveOpenRouterModelAlias);
const mockedStoredModels = jest.mocked(getOpenRouterModelsMetadataFromDatabase);

const ALIAS_TARGETS: Record<string, string> = {
  '~moonshotai/kimi-latest': 'moonshotai/kimi-k2.6',
  '~z-ai/glm-latest': 'z-ai/glm-5.2',
  '~stealth/exclusive-latest': 'stealth/exclusive',
  '~moonshotai/retired-latest': 'moonshotai/retired',
  '~example/unknown-latest': 'example/unknown',
};

function keys(entries: Record<string, boolean>): EnabledByokProvider[] {
  return Object.entries(entries).map(([providerId, serveCatalogModels]) => ({
    providerId: providerId as EnabledByokProvider['providerId'],
    serveCatalogModels,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedIsValid.mockImplementation(async modelId => modelId !== 'moonshotai/retired');
  mockedResolveAlias.mockImplementation(async modelId => ALIAS_TARGETS[modelId] ?? modelId);
  mockedStoredModels.mockResolvedValue(
    Object.fromEntries(
      Object.entries(ALIAS_TARGETS).map(([id, slug]) => [id, { alias_target: { slug } }])
    ) as unknown as Awaited<ReturnType<typeof getOpenRouterModelsMetadataFromDatabase>>
  );
});

describe('catalog mode support', () => {
  test('requires a models.dev id and at least one current catalog mapping', async () => {
    expect(supportsCatalogMode('synthetic')).toBe(true);
    expect(supportsCatalogMode('martian')).toBe(false);
    await expect(offersCatalogMode('synthetic')).resolves.toBe(true);
    await expect(offersCatalogMode('morph-byok')).resolves.toBe(false);
    await expect(offersCatalogMode('chutes-byok')).resolves.toBe(false);
    await expect(offersCatalogMode('martian')).resolves.toBe(false);
  });

  test('lists the current catalog ids a provider serves with their primary model', async () => {
    const entries = await listDirectByokCatalogModels('synthetic');

    expect(entries.map(({ catalogModelId, model }) => [catalogModelId, model.id])).toEqual([
      ['moonshotai/kimi-k2.6', 'hf:moonshotai/Kimi-K2.6'],
    ]);
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

  test('lists current catalog ids served by catalog-mode keys only', async () => {
    mockedKeys.mockResolvedValueOnce(keys({ synthetic: true, 'zai-coding': false, martian: true }));

    const catalogIds = await getDirectByokCatalogModelIds({ type: 'user', id: 'user-id' });

    expect([...catalogIds]).toEqual(['moonshotai/kimi-k2.6', '~moonshotai/kimi-latest']);
  });

  test('omits latest aliases that left the catalog', async () => {
    mockedKeys.mockResolvedValueOnce(keys({ synthetic: true }));
    mockedIsValid.mockImplementation(
      async modelId => modelId !== 'moonshotai/retired' && modelId !== '~moonshotai/kimi-latest'
    );

    const catalogIds = await getDirectByokCatalogModelIds({ type: 'user', id: 'user-id' });

    expect([...catalogIds]).toEqual(['moonshotai/kimi-k2.6']);
  });

  test.each([
    [
      'z-ai',
      ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2', '~moonshotai/kimi-latest', '~z-ai/glm-latest'],
    ],
    ['synthetic', ['moonshotai/kimi-k2.6', '~moonshotai/kimi-latest']],
  ])(
    'lists only catalog ids a serving key provider passes the check for (%s)',
    async (allowedProviderId, expected) => {
      mockedKeys.mockResolvedValueOnce(keys({ synthetic: true, 'zai-coding': true }));
      const isServingAllowed = jest.fn(
        async (_catalogModelId: string, policyProviderId: string) =>
          policyProviderId === allowedProviderId
      );

      const catalogIds = await getDirectByokCatalogModelIds(
        { type: 'organization', id: 'org' },
        isServingAllowed
      );

      expect([...catalogIds]).toEqual(expected);
      expect(isServingAllowed).toHaveBeenCalledWith('moonshotai/kimi-k2.6', 'synthetic');
      expect(isServingAllowed).toHaveBeenCalledWith('~z-ai/glm-latest', 'z-ai');
    }
  );

  test('lists no latest aliases without catalog-mode keys', async () => {
    mockedKeys.mockResolvedValueOnce(keys({ 'zai-coding': false }));

    const catalogIds = await getDirectByokCatalogModelIds({ type: 'user', id: 'user-id' });

    expect([...catalogIds]).toEqual([]);
    expect(mockedStoredModels).not.toHaveBeenCalled();
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

  test('serves a latest alias with the models that serve its target', async () => {
    const found = await findDirectByokCatalogModels('~moonshotai/kimi-latest');

    expect(found.map(({ provider, model }) => [provider.id, model.id])).toEqual([
      ['synthetic', 'hf:moonshotai/Kimi-K2.6'],
      ['zai-coding', 'kimi-k2.6'],
    ]);
  });

  test('ignores unknown, unmapped, Kilo-exclusive, retired and retired-target aliases', async () => {
    await expect(findDirectByokCatalogModels('~moonshotai/unknown-latest')).resolves.toEqual([]);
    await expect(findDirectByokCatalogModels('~example/unknown-latest')).resolves.toEqual([]);
    await expect(findDirectByokCatalogModels('~stealth/exclusive-latest')).resolves.toEqual([]);
    await expect(findDirectByokCatalogModels('~moonshotai/retired-latest')).resolves.toEqual([]);
    mockedIsValid.mockImplementation(async modelId => modelId !== '~z-ai/glm-latest');
    await expect(findDirectByokCatalogModels('~z-ai/glm-latest')).resolves.toEqual([]);
    mockedIsValid.mockImplementation(async modelId => modelId !== 'z-ai/glm-5.2');
    await expect(findDirectByokCatalogModels('~z-ai/glm-latest')).resolves.toEqual([]);
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
