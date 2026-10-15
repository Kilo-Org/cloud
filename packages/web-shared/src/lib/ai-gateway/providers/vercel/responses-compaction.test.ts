import { describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { calculateCost_mUsd } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  endpointPricingToPricingTiers,
  getVercelCompactionPricingTiers,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/responses-compaction';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getVercelModelsMetadataFromDatabase: jest.fn(),
}));

const mockedGetVercelModelsMetadata = jest.mocked(getVercelModelsMetadataFromDatabase);

// Shape of Vercel's listing for openai/gpt-5.4.
const gpt54OpenAiPricing = {
  prompt: '0.0000025',
  prompt_tiers: [
    { cost: '0.0000025', min: 0, max: 272000 },
    { cost: '0.000005', min: 272000 },
  ],
  completion: '0.000015',
  completion_tiers: [
    { cost: '0.000015', min: 0, max: 272000 },
    { cost: '0.0000225', min: 272000 },
  ],
  input_cache_read: '0.00000025',
  input_cache_read_tiers: [
    { cost: '0.00000025', min: 0, max: 272000 },
    { cost: '0.0000005', min: 272000 },
  ],
  discount: 0,
};

describe('endpointPricingToPricingTiers', () => {
  it('converts per-token prices without tiers', () => {
    expect(
      endpointPricingToPricingTiers({
        prompt: '0.00000005',
        completion: '0.0000004',
        input_cache_read: '0.00000001',
        input_cache_write: '0',
      })
    ).toEqual([
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: expect.closeTo(0.05),
          completion_per_million: expect.closeTo(0.4),
          input_cache_read_per_million: expect.closeTo(0.01),
          input_cache_write_per_million: 0,
        },
      },
    ]);
  });

  it('converts input-length tiers', () => {
    expect(endpointPricingToPricingTiers(gpt54OpenAiPricing)).toEqual([
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: expect.closeTo(2.5),
          completion_per_million: expect.closeTo(15),
          input_cache_read_per_million: expect.closeTo(0.25),
          input_cache_write_per_million: null,
        },
      },
      {
        start_context_length: 272000,
        pricing: {
          prompt_per_million: expect.closeTo(5),
          completion_per_million: expect.closeTo(22.5),
          input_cache_read_per_million: expect.closeTo(0.5),
          input_cache_write_per_million: null,
        },
      },
    ]);
  });

  it('charges long-context compactions at the higher tier', () => {
    const tiers = endpointPricingToPricingTiers(gpt54OpenAiPricing);
    if (!tiers) throw new Error('expected pricing tiers');

    const cost = calculateCost_mUsd(
      {
        uncachedInputTokens: 200_000,
        cacheHitTokens: 100_000,
        cacheWriteTokens: 0,
        totalOutputTokens: 4_000,
      },
      tiers
    );

    // 200k * $5/M + 100k * $0.5/M + 4k * $22.5/M = $1.14
    expect(cost).toBeCloseTo(1_140_000);
  });

  it.each([{ prompt: 'not-a-number' }, { completion: '-1' }])(
    'returns null for malformed prices %j',
    override => {
      expect(
        endpointPricingToPricingTiers({ prompt: '0.000001', completion: '0.000002', ...override })
      ).toBeNull();
    }
  );
});

describe('getVercelCompactionPricingTiers', () => {
  function storedModel(endpoints: StoredModel['endpoints']): StoredModel {
    return { id: 'openai/gpt-5.4', name: 'GPT-5.4', endpoints };
  }

  it('prices from the OpenAI endpoint', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue({
      'openai/gpt-5.4': storedModel([
        { provider_name: 'azure', pricing: { prompt: '1', completion: '1' } },
        { provider_name: 'openai', pricing: gpt54OpenAiPricing },
      ]),
    });

    const tiers = await getVercelCompactionPricingTiers('openai/gpt-5.4');

    expect(tiers?.[0].pricing.prompt_per_million).toBeCloseTo(2.5);
  });

  it('returns null without an OpenAI endpoint', async () => {
    mockedGetVercelModelsMetadata.mockResolvedValue({
      'openai/gpt-5.4': storedModel([
        { provider_name: 'azure', pricing: { prompt: '1', completion: '1' } },
      ]),
    });

    await expect(getVercelCompactionPricingTiers('openai/gpt-5.4')).resolves.toBeNull();
  });
});
