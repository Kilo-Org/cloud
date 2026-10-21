import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import type { StoredModel } from '@kilocode/db';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModel,
  isFreeModelExcludingCustomLlms,
  isAnonymousFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));

describe('isAnonymousFreeModel', () => {
  beforeEach(() => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockClear().mockResolvedValue({});
  });

  test.each(['openrouter/free', 'kilo-auto/free'])(
    'allows the built-in free router %s without catalog metadata',
    async model => {
      await expect(isAnonymousFreeModel(model)).resolves.toBe(true);
    }
  );

  test.each(['test/public:free', 'stealth/public-alpha'])(
    'requires public catalog membership for a free-shaped id: %s',
    async model => {
      jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
        'openai/gpt-4o': { id: 'openai/gpt-4o' } as StoredModel,
      });
      await expect(isAnonymousFreeModel(model)).resolves.toBe(false);
      jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
        [model]: { id: model } as StoredModel,
      });
      await expect(isAnonymousFreeModel(model)).resolves.toBe(true);
    }
  );

  test.each(['test/public:free', 'stealth/public-alpha'])(
    'distinguishes unavailable public metadata from an unknown model: %s',
    async model => {
      await expect(isAnonymousFreeModel(model)).resolves.toBeNull();
    }
  );

  test('rejects paid-shaped ids without needing public metadata', async () => {
    await expect(isAnonymousFreeModel('acme/private-model')).resolves.toBe(false);
    expect(getOpenRouterModelsMetadataFromDatabase).not.toHaveBeenCalled();
  });

  test('never treats a catalog-listed paid model as anonymously free', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      'openai/gpt-4o': { id: 'openai/gpt-4o' } as StoredModel,
    });
    await expect(isAnonymousFreeModel('openai/gpt-4o')).resolves.toBe(false);
  });
});

describe('isFreeModel', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest('acme/custom-model');
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/custom-model');
  });

  test('treats every custom LLM as free', async () => {
    await expect(isFreeModel('acme/custom-model')).resolves.toBe(true);
    expect(isFreeModelExcludingCustomLlms('acme/custom-model')).toBe(false);
  });

  test('assumes custom LLMs require data collection, like other free models', async () => {
    await expect(hasBestEffortGuessDataCollectionRequirement('acme/custom-model')).resolves.toBe(
      true
    );
    await expect(hasBestEffortGuessDataCollectionRequirement('openai/gpt-4o')).resolves.toBe(false);
  });

  test('follows the built-in rules for other models', async () => {
    await expect(isFreeModel('openrouter/free')).resolves.toBe(true);
    await expect(isFreeModel('openai/gpt-4o')).resolves.toBe(false);
  });
});
