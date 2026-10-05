import { beforeEach, describe, expect, test } from '@jest/globals';
import { addUserByokAvailability, getModelUserByokProviders } from '@/lib/ai-gateway/byok';
import { canRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
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

jest.mock('@/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: jest.fn(),
}));

const ROUTES: ReadonlySet<string> = new Set(['groq']);
const SONNET = 'anthropic/claude-sonnet-4.5';
const OPENROUTER_ONLY_MODEL = 'vendor/openrouter-only';

beforeEach(() => {
  jest.mocked(canRouteToVercel).mockReset();
  jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
    [SONNET]: {
      id: SONNET,
      endpoints: [{ provider_name: 'anthropic' }, { provider_name: 'bedrock' }],
    } as StoredModel,
  });
  jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set([SONNET]));
  jest.mocked(isValidOpenRouterModelId).mockResolvedValue(true);
});

describe('addUserByokAvailability', () => {
  const sonnet = { id: SONNET } as OpenRouterModel;

  test('marks a Vercel AI Gateway key available only when Vercel honors the allowed providers', async () => {
    jest.mocked(canRouteToVercel).mockResolvedValue(false);

    const [restricted] = await addUserByokAvailability(
      [sonnet],
      ['vercel-ai-gateway'],
      () => ROUTES
    );
    const [unrestricted] = await addUserByokAvailability([sonnet], ['vercel-ai-gateway']);

    expect(restricted.hasUserByokAvailable).toBe(false);
    expect(unrestricted.hasUserByokAvailable).toBe(true);
    expect(canRouteToVercel).toHaveBeenCalledTimes(1);
  });

  test('marks an OpenRouter key available regardless of allowed providers', async () => {
    jest.mocked(canRouteToVercel).mockResolvedValue(false);

    const [model] = await addUserByokAvailability([sonnet], ['openrouter'], () => ROUTES);

    expect(model.hasUserByokAvailable).toBe(true);
  });
});

describe('getModelUserByokProviders', () => {
  test('lists inference provider keys before gateway keys in preference order', async () => {
    expect(await getModelUserByokProviders(SONNET)).toEqual([
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
