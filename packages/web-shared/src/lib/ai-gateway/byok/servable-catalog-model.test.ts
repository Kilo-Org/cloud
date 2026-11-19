import { beforeEach, describe, expect, test } from '@jest/globals';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  getVercelModelsFromDatabase,
  isValidOpenRouterModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isValidVercelModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { isByokServableCatalogModelId, isKiloCatalogModelId } from './servable-catalog-model';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  isValidOpenRouterModelId: jest.fn(),
  getVercelModelsFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  isValidVercelModelId: jest.fn(),
}));

const OPENROUTER_IDS = new Set(['anthropic/claude-sonnet-4.6', 'vendor/model:free']);
const VERCEL_ONLY_IDS = new Set(['vendor/vercel-only']);

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(isValidOpenRouterModelId)
    .mockImplementation(async modelId => OPENROUTER_IDS.has(modelId));
  jest
    .mocked(isValidVercelModelId)
    .mockImplementation(async modelId => VERCEL_ONLY_IDS.has(modelId));
  jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set(['vendor/vercel-only']));
});

describe('isKiloCatalogModelId', () => {
  test('admits OpenRouter ids and the ids of models only Vercel serves', async () => {
    await expect(isKiloCatalogModelId('anthropic/claude-sonnet-4.6')).resolves.toBe(true);
    await expect(isKiloCatalogModelId('vendor/vercel-only')).resolves.toBe(true);
    await expect(isKiloCatalogModelId('vendor/unknown')).resolves.toBe(false);
  });

  test('admits no Vercel-only id while the Vercel model list is unavailable', async () => {
    jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set());
    await expect(isKiloCatalogModelId('vendor/vercel-only')).resolves.toBe(false);
    expect(isValidVercelModelId).not.toHaveBeenCalled();
  });
});

describe('isByokServableCatalogModelId', () => {
  test('serves current paid catalog ids', async () => {
    await expect(isByokServableCatalogModelId('anthropic/claude-sonnet-4.6')).resolves.toBe(true);
    await expect(isByokServableCatalogModelId('vendor/vercel-only')).resolves.toBe(true);
  });

  test.each([
    ['a retired id', 'vendor/retired'],
    ['a free model', 'vendor/model:free'],
    ['the auto small free model', AUTO_SMALL_TARGET_MODELS.free],
  ])('never serves %s', async (_name, modelId) => {
    await expect(isByokServableCatalogModelId(modelId)).resolves.toBe(false);
  });

  test('checks the catalog only for ids Kilo does not pay for', async () => {
    await isByokServableCatalogModelId('vendor/model:free');
    expect(isValidOpenRouterModelId).not.toHaveBeenCalled();
  });
});
