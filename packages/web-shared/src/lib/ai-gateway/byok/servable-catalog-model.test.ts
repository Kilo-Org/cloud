import { describe, expect, test } from '@jest/globals';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isValidOpenRouterModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isByokServableCatalogModelId } from './servable-catalog-model';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  isValidOpenRouterModelId: jest.fn(async (modelId: string) => modelId !== 'vendor/retired'),
}));

describe('isByokServableCatalogModelId', () => {
  test('serves current paid catalog ids', async () => {
    await expect(isByokServableCatalogModelId('anthropic/claude-sonnet-4.6')).resolves.toBe(true);
  });

  test.each([
    ['a retired id', 'vendor/retired'],
    ['a free model', 'vendor/model:free'],
    ['the auto small free model', AUTO_SMALL_TARGET_MODELS.free],
  ])('never serves %s', async (_name, modelId) => {
    await expect(isByokServableCatalogModelId(modelId)).resolves.toBe(false);
  });

  test('checks the catalog only for ids Kilo does not pay for', async () => {
    jest.mocked(isValidOpenRouterModelId).mockClear();
    await isByokServableCatalogModelId('vendor/model:free');
    expect(isValidOpenRouterModelId).not.toHaveBeenCalled();
  });
});
