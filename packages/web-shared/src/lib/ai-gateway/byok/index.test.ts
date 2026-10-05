import { beforeEach, describe, expect, test } from '@jest/globals';
import { getModelUserByokProviders } from '@/lib/ai-gateway/byok';
import {
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { kiloExclusiveModels } from '@/lib/ai-gateway/kilo-exclusive-models';
import type { StoredModel } from '@kilocode/db';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getVercelModelsMetadataFromDatabase: jest.fn(),
  getVercelModelsFromDatabase: jest.fn(),
  isValidOpenRouterModelId: jest.fn(),
  resolveOpenRouterModelAlias: jest.fn(async (modelId: string) => modelId),
}));

const VERCEL_ONLY_SONNET = 'anthropic/claude-sonnet-4.5';
const OPENROUTER_ONLY_MODEL = 'vendor/openrouter-only';

beforeEach(() => {
  jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
    [VERCEL_ONLY_SONNET]: {
      id: VERCEL_ONLY_SONNET,
      endpoints: [{ provider_name: 'anthropic' }, { provider_name: 'bedrock' }],
    } as StoredModel,
  });
  jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set([VERCEL_ONLY_SONNET]));
  jest.mocked(isValidOpenRouterModelId).mockResolvedValue(true);
});

describe('getModelUserByokProviders', () => {
  test('lists inference provider keys before gateway keys in preference order', async () => {
    expect(await getModelUserByokProviders(VERCEL_ONLY_SONNET)).toEqual([
      'anthropic',
      'bedrock',
      'vercel-ai-gateway',
      'openrouter',
    ]);
  });

  test('offers only the OpenRouter key for models Vercel does not serve', async () => {
    expect(await getModelUserByokProviders(OPENROUTER_ONLY_MODEL)).toEqual(['openrouter']);
  });

  test('offers no OpenRouter key for models OpenRouter does not list', async () => {
    jest.mocked(isValidOpenRouterModelId).mockResolvedValue(false);

    expect(await getModelUserByokProviders(OPENROUTER_ONLY_MODEL)).toEqual([]);
  });

  test.each(['vendor/model:free', kiloExclusiveModels[0].public_id])(
    'keeps %s on Kilo accounts',
    async modelId => {
      jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set([modelId]));

      const providers = await getModelUserByokProviders(modelId);

      expect(providers).not.toContain('vercel-ai-gateway');
      expect(providers).not.toContain('openrouter');
    }
  );
});
