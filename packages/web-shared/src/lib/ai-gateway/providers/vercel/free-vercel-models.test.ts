import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import {
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  isFreeVercelModel,
  isFreeVercelStoredModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/free-vercel-models';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import type * as GatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getVercelModelsMetadataFromDatabase: jest.fn(),
  isValidOpenRouterModelId: jest.fn(),
}));

// Seeded before the first lookup, which caches the overrides for the whole file.
beforeAll(async () => {
  await cleanupDbForTest();
  await db.insert(ai_gateway_config).values({
    vercel_model_id_overrides: {
      overrides: [
        { openrouter_model_id: 'reflection/beam-cheap', vercel_model_id: 'reflection/beam-free' },
        { openrouter_model_id: 'reflection/beam-zero-free', vercel_model_id: 'reflection/beam' },
      ],
    },
  });
});

function storedModel(
  id: string,
  {
    input = '0',
    output = '0',
    endpoints = [{ provider_name: 'reflection', pricing: { prompt: '0', completion: '0' } }],
  }: { input?: string; output?: string; endpoints?: StoredModel['endpoints'] } = {}
): StoredModel {
  return {
    id,
    name: id,
    type: 'language',
    endpoints,
    catalog: {
      description: '',
      created: 1_790_000_000,
      context_window: 128_000,
      modalities: { input: ['text'], output: ['text'] },
      pricing: { input, output },
    },
  };
}

describe('isFreeVercelStoredModel', () => {
  it('accepts a zero-priced language model whose id ends with -free', () => {
    expect(isFreeVercelStoredModel(storedModel('reflection/beam-free'))).toBe(true);
  });

  it('accepts endpoints without pricing', () => {
    const model = storedModel('reflection/beam-free', {
      endpoints: [{ provider_name: 'reflection' }],
    });
    expect(isFreeVercelStoredModel(model)).toBe(true);
  });

  it('rejects a zero-priced model without the -free suffix', () => {
    expect(isFreeVercelStoredModel(storedModel('reflection/beam'))).toBe(false);
  });

  it.each([
    ['catalog input', { input: '0.0000001' }],
    ['catalog output', { output: '0.0000001' }],
    [
      'an endpoint',
      {
        endpoints: [
          { provider_name: 'reflection', pricing: { prompt: '0', completion: '0' } },
          { provider_name: 'other', pricing: { prompt: '0', completion: '0.000001' } },
        ],
      },
    ],
  ])('rejects a model with a price on %s', (_name, overrides) => {
    const model = storedModel('reflection/beam-free', overrides);
    expect(isFreeVercelStoredModel(model)).toBe(false);
  });

  it('rejects a model without catalog data or of another type', () => {
    const { catalog: _catalog, ...withoutCatalog } = storedModel('reflection/beam-free');
    expect(isFreeVercelStoredModel(withoutCatalog)).toBe(false);
    expect(
      isFreeVercelStoredModel({
        ...storedModel('reflection/beam-free'),
        type: 'embedding',
      })
    ).toBe(false);
  });
});

describe('isFreeVercelModel', () => {
  beforeEach(() => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'reflection/beam-free': storedModel('reflection/beam-free'),
      'zai/glm-5-free': storedModel('zai/glm-5-free'),
    });
    jest.mocked(isValidOpenRouterModelId).mockResolvedValue(false);
  });

  it('treats a free Vercel-only model as free, also through isFreeModel', async () => {
    await expect(isFreeVercelModel('reflection/beam-free')).resolves.toBe(true);
    await expect(isFreeModel('reflection/beam-free')).resolves.toBe(true);
  });

  it('maps the requested id to the Vercel id', async () => {
    await expect(isFreeVercelModel('z-ai/glm-5-free')).resolves.toBe(true);
  });

  it('does not treat a model OpenRouter also serves as free', async () => {
    jest.mocked(isValidOpenRouterModelId).mockResolvedValue(true);

    await expect(isFreeVercelModel('reflection/beam-free')).resolves.toBe(false);
  });

  it('decides by the Vercel id an override routes to, not the requested id', async () => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'reflection/beam-free': storedModel('reflection/beam-free'),
      'reflection/beam': storedModel('reflection/beam'),
    });

    await expect(isFreeVercelModel('reflection/beam-cheap')).resolves.toBe(true);
    await expect(isFreeVercelModel('reflection/beam-zero-free')).resolves.toBe(false);
  });

  it('does not treat a model Vercel does not list as free', async () => {
    await expect(isFreeVercelModel('vendor/unknown-free')).resolves.toBe(false);
  });
});
