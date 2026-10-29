import { beforeEach, describe, expect, test } from '@jest/globals';
import type { StoredModel } from '@kilocode/db';
import type { StoredModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  kiloExclusiveModelFixture,
  useKiloExclusiveModel,
} from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getVercelModelsMetadataFromDatabase: jest.fn(),
  getVercelModelsFromDatabase: jest.fn(),
  isValidOpenRouterModelId: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  mapModelIdToVercel: jest.fn(),
}));

import {
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  addDirectByokCatalogAvailability,
  addUserByokAvailability,
  getModelUserByokProviders,
  hasInferenceProviderUserByokForModel,
  isInferenceProviderUserByok,
} from '@kilocode/web-shared/lib/ai-gateway/byok';

const EXCLUSIVE_MODEL_ID = kiloExclusiveModelFixture.public_id;

useKiloExclusiveModel();

const mockedGetVercelModelsMetadata = jest.mocked(getVercelModelsMetadataFromDatabase);
const mockedMapModelIdToVercel = jest.mocked(mapModelIdToVercel);

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'test',
    },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 0,
  };
}

function storedModel(id: string, providerNames: string[]): StoredModel {
  return { id, name: id, endpoints: providerNames.map(provider_name => ({ provider_name })) };
}

const metadata: StoredModelMap = {
  'anthropic/claude-fixture': storedModel('anthropic/claude-fixture', ['anthropic', 'bedrock']),
  'openai/gpt-fixture': storedModel('openai/gpt-fixture', ['openai']),
  'mistral/codestral-fixture': storedModel('mistral/codestral-fixture', ['mistral']),
  [EXCLUSIVE_MODEL_ID]: storedModel(EXCLUSIVE_MODEL_ID, ['anthropic']),
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedMapModelIdToVercel.mockImplementation(async modelId => modelId);
  // Gateway keys are covered in model-providers.test.ts; keep them out of these cases.
  jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set());
  jest.mocked(isValidOpenRouterModelId).mockResolvedValue(false);
});

describe('addUserByokAvailability', () => {
  test('reads the Vercel metadata once and derives every model from it', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue(metadata);
    const models = [
      makeModel('anthropic/claude-fixture'),
      makeModel('openai/gpt-fixture'),
      makeModel('mistral/codestral-fixture'),
      makeModel(EXCLUSIVE_MODEL_ID),
      makeModel('absent/model'),
    ];

    const result = await addUserByokAvailability(models, ['anthropic', 'codestral']);

    expect(mockedGetVercelModelsMetadata).toHaveBeenCalledTimes(1);
    expect(result.map(model => [model.id, model.hasUserByokAvailable])).toEqual([
      ['anthropic/claude-fixture', true],
      ['openai/gpt-fixture', false],
      ['mistral/codestral-fixture', true],
      [EXCLUSIVE_MODEL_ID, false],
      ['absent/model', false],
    ]);
    expect(result.map(model => model.name)).toEqual(models.map(model => model.name));
    expect(models[0]).not.toHaveProperty('hasUserByokAvailable');
  });

  test('ignores provider keys outside the organization provider allow-list', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue(metadata);
    const models = [makeModel('anthropic/claude-fixture')];

    const [denied] = await addUserByokAvailability(
      models,
      ['bedrock'],
      () => new Set(['anthropic'])
    );
    const [allowed] = await addUserByokAvailability(
      models,
      ['bedrock'],
      () => new Set(['amazon-bedrock'])
    );

    expect(denied?.hasUserByokAvailable).toBe(false);
    expect(allowed?.hasUserByokAvailable).toBe(true);
  });

  test('reports no availability when the Vercel metadata is empty', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue({});
    const models = [makeModel('anthropic/claude-fixture'), makeModel(EXCLUSIVE_MODEL_ID)];

    const result = await addUserByokAvailability(models, ['anthropic']);

    expect(mockedGetVercelModelsMetadata).toHaveBeenCalledTimes(1);
    expect(result.map(model => model.hasUserByokAvailable)).toEqual([false, false]);
  });

  test.each(['vercel-ai-gateway', 'openrouter', 'anthropic'] as const)(
    'does not mark an id a custom LLM owns for a %s key, since routing serves the custom LLM',
    async providerId => {
      mockedGetVercelModelsMetadata.mockResolvedValue(metadata);
      jest
        .mocked(getVercelModelsFromDatabase)
        .mockResolvedValue(new Set(['anthropic/claude-fixture']));
      jest.mocked(isValidOpenRouterModelId).mockResolvedValue(true);
      const models = [makeModel('anthropic/claude-fixture')];
      const [beforeCustomLlm] = await addUserByokAvailability(models, [providerId]);
      expect(beforeCustomLlm?.hasUserByokAvailable).toBe(true);

      await insertCustomLlmForTest(
        'anthropic/claude-fixture',
        publicCustomLlmDefinition(['custom-provider'])
      );
      try {
        const [owned] = await addUserByokAvailability(models, [providerId]);
        expect(owned?.hasUserByokAvailable).toBe(false);
      } finally {
        await deleteCustomLlmForTest('anthropic/claude-fixture');
      }
    }
  );

  test('marks catalog models served by a catalog-mode direct BYOK key', async () => {
    const models = [makeModel('moonshotai/kimi-k2.6'), makeModel('openai/gpt-fixture')].map(
      model => ({ ...model, hasUserByokAvailable: false })
    );

    const result = addDirectByokCatalogAvailability(models, new Set(['moonshotai/kimi-k2.6']));

    expect(result.map(model => [model.id, model.hasUserByokAvailable])).toEqual([
      ['moonshotai/kimi-k2.6', true],
      ['openai/gpt-fixture', false],
    ]);
  });
});

describe('hasInferenceProviderUserByokForModel', () => {
  const noCatalogModels: ReadonlySet<string> = new Set();

  test('does not count a provider key sent through Vercel, which the allow-list can name', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue(metadata);

    await expect(
      hasInferenceProviderUserByokForModel('anthropic/claude-fixture', ['bedrock'], noCatalogModels)
    ).resolves.toBe(false);
    await expect(
      hasInferenceProviderUserByokForModel(
        'mistral/codestral-fixture',
        ['codestral', 'mistral'],
        noCatalogModels
      )
    ).resolves.toBe(false);
  });

  test('counts a catalog-mode direct BYOK key without reading the Vercel metadata', async () => {
    await expect(
      hasInferenceProviderUserByokForModel(
        'moonshotai/kimi-k2.6',
        [],
        new Set(['moonshotai/kimi-k2.6'])
      )
    ).resolves.toBe(true);
    expect(mockedGetVercelModelsMetadata).not.toHaveBeenCalled();
  });

  test('does not count gateway keys', async () => {
    await expect(
      hasInferenceProviderUserByokForModel(
        'anthropic/claude-fixture',
        ['openrouter', 'vercel-ai-gateway'],
        noCatalogModels
      )
    ).resolves.toBe(false);
    expect(mockedGetVercelModelsMetadata).not.toHaveBeenCalled();
  });

  test('keeps Kilo-exclusive models on Kilo accounts', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue(metadata);

    await expect(
      hasInferenceProviderUserByokForModel(EXCLUSIVE_MODEL_ID, ['anthropic'], noCatalogModels)
    ).resolves.toBe(false);
  });

  test('does not count keys for an id a custom LLM owns, which routing serves first', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue(metadata);
    await insertCustomLlmForTest(
      'anthropic/claude-fixture',
      publicCustomLlmDefinition(['custom-provider'])
    );
    try {
      await expect(
        hasInferenceProviderUserByokForModel(
          'anthropic/claude-fixture',
          ['anthropic'],
          new Set(['anthropic/claude-fixture'])
        )
      ).resolves.toBe(false);
    } finally {
      await deleteCustomLlmForTest('anthropic/claude-fixture');
    }
  });
});

describe('isInferenceProviderUserByok', () => {
  test.each([
    [
      'a provider key sent through Vercel',
      [{ decryptedAPIKey: 'key', providerId: 'anthropic' }],
      true,
    ],
    ['a direct BYOK key', [{ decryptedAPIKey: 'key', providerId: 'synthetic' }], true],
    ['an OpenRouter key', [{ decryptedAPIKey: 'key', providerId: 'openrouter' }], false],
    [
      'a Vercel AI Gateway key',
      [{ decryptedAPIKey: 'key', providerId: 'vercel-ai-gateway' }],
      false,
    ],
    ['no key', null, false],
  ] as const)('classifies %s', (_name, userByok, expected) => {
    expect(isInferenceProviderUserByok(userByok)).toBe(expected);
  });
});

describe('getModelUserByokProviders', () => {
  test('returns the deduped providers with codestral first', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue(metadata);

    await expect(getModelUserByokProviders('mistral/codestral-fixture')).resolves.toEqual([
      'codestral',
      'mistral',
    ]);
    await expect(getModelUserByokProviders('anthropic/claude-fixture')).resolves.toEqual([
      'anthropic',
      'bedrock',
    ]);
    await expect(getModelUserByokProviders('absent/model')).resolves.toEqual([]);
    expect(mockedGetVercelModelsMetadata).toHaveBeenCalledTimes(3);
  });

  test('returns no providers when the Vercel metadata is empty', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue({});

    await expect(getModelUserByokProviders('anthropic/claude-fixture')).resolves.toEqual([]);
  });
});
