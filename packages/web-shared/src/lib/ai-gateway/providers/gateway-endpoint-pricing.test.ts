import { describe, expect, it } from '@jest/globals';
import type { Endpoint } from '@kilocode/db/schema-types';
import type { GatewayModelWithEndpoints } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getVercelModelsMetadataFromDatabase: jest.fn(async () => ({})),
  resolveOpenRouterModelAlias: jest.fn(async (modelId: string) => modelId),
}));

import {
  EMPTY_VERCEL_PRICING_METADATA,
  getProviderDisplayPricing,
  getVercelModelForPricing,
  isVercelEndpointOfProvider,
} from './gateway-endpoint-pricing';

function vercelModel(
  ...endpoints: Array<{ provider: string; pricing?: Endpoint['pricing'] }>
): GatewayModelWithEndpoints {
  return {
    id: 'vendor/model',
    name: 'Model',
    endpoints: endpoints.map(({ provider, pricing }) => ({ provider_name: provider, pricing })),
  };
}

describe('isVercelEndpointOfProvider', () => {
  it.each([
    ['google-vertex/global', 'vertex'],
    ['google-vertex/global', 'vertexAnthropic'],
    ['google-vertex', 'vertex'],
    ['together', 'togetherai'],
    ['z-ai/fp8', 'zai'],
    ['amazon-bedrock', 'bedrock'],
    ['novita/fp8', 'novita'],
  ])('matches OpenRouter %s with Vercel %s', (openRouterProvider, vercelProvider) => {
    expect(isVercelEndpointOfProvider({ provider_name: vercelProvider }, openRouterProvider)).toBe(
      true
    );
  });

  it.each([
    ['together', 'together'],
    ['z-ai', 'novita'],
    ['google-vertex', 'google'],
    ['novita', 'deepinfra'],
  ])('does not match OpenRouter %s with Vercel %s', (openRouterProvider, vercelProvider) => {
    expect(isVercelEndpointOfProvider({ provider_name: vercelProvider }, openRouterProvider)).toBe(
      false
    );
  });

  it('falls back to the endpoint tag when it has no provider name', () => {
    expect(isVercelEndpointOfProvider({ tag: 'togetherai' }, 'together')).toBe(true);
  });
});

describe('getProviderDisplayPricing', () => {
  it('returns the OpenRouter price when there is no Vercel model', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        { prompt: '0.000001', completion: '0.000002' },
        undefined,
        'shortContext'
      )
    ).toEqual({ prompt: '0.000001', completion: '0.000002' });
  });

  it('returns undefined without an OpenRouter price', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        undefined,
        vercelModel({ provider: 'novita', pricing: { prompt: '1', completion: '1' } }),
        'shortContext'
      )
    ).toBeUndefined();
  });

  it('raises each price to the one Vercel charges where higher', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        { prompt: '0.000001', completion: '0.000005' },
        vercelModel({
          provider: 'novita',
          pricing: { prompt: '0.000002', completion: '0.000004' },
        }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000002', completion: '0.000005' });
  });

  it.each([
    ['google-vertex/global', 'vertexAnthropic'],
    ['google-vertex', 'vertex'],
    ['together', 'togetherai'],
    ['z-ai/fp8', 'zai'],
  ])('compares OpenRouter %s with the Vercel %s endpoint', (openRouterProvider, vercelProvider) => {
    expect(
      getProviderDisplayPricing(
        openRouterProvider,
        { prompt: '0.000001', completion: '0.000002' },
        vercelModel({
          provider: vercelProvider,
          pricing: { prompt: '0.000003', completion: '0.000001' },
        }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000003', completion: '0.000002' });
  });

  it('undoes the OpenRouter discount before comparing', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        { prompt: '0.000001', completion: '0.000002', discount: 0.5 },
        vercelModel({
          provider: 'novita',
          pricing: { prompt: '0.0000015', completion: '0.000003' },
        }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000002000000', completion: '0.000004000000' });
  });

  it('undoes a Vercel discount too', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        { prompt: '0.000001', completion: '0.000002' },
        vercelModel({
          provider: 'novita',
          pricing: { prompt: '0.0000015', completion: '0.0000005', discount: 0.5 },
        }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000003000000', completion: '0.000002' });
  });

  it('ignores the prices of other providers', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        { prompt: '0.000001', completion: '0.000002' },
        vercelModel(
          { provider: 'deepinfra', pricing: { prompt: '0.00001', completion: '0.00001' } },
          { provider: 'zai', pricing: { prompt: '0.00001', completion: '0.00001' } }
        ),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000001', completion: '0.000002' });
  });

  it('ignores Vercel endpoints without a price', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        { prompt: '0.000001', completion: '0.000002' },
        vercelModel({ provider: 'novita' }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000001', completion: '0.000002' });
  });

  it('takes the highest of several Vercel endpoints of the provider', () => {
    expect(
      getProviderDisplayPricing(
        'google-vertex',
        { prompt: '0.000001', completion: '0.000002' },
        vercelModel(
          { provider: 'vertex', pricing: { prompt: '0.000002', completion: '0.000001' } },
          { provider: 'vertexAnthropic', pricing: { prompt: '0.000001', completion: '0.000004' } }
        ),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000002', completion: '0.000004' });
  });

  it('shows the short-context price, ignoring long-context overrides', () => {
    expect(
      getProviderDisplayPricing(
        'openai',
        {
          prompt: '0.000008',
          completion: '0.00004',
          overrides: [{ min_prompt_tokens: 272000, prompt: '0.000016', completion: '0.00006' }],
        },
        vercelModel({ provider: 'openai', pricing: { prompt: '0.000007', completion: '0.00003' } }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000008', completion: '0.00004' });
  });

  it('keeps time-of-day windows and the Vercel peak multiplier', () => {
    expect(
      getProviderDisplayPricing(
        'novita',
        {
          prompt: '0.000001',
          completion: '0.000002',
          overrides: [
            { utc_start: 0, utc_end: 1400, prompt: '0.0000015', completion: '0.000003' },
            { min_prompt_tokens: 272000, prompt: '0.00001', completion: '0.00002' },
          ],
        },
        vercelModel({
          provider: 'novita',
          pricing: { prompt: '0.000001', completion: '0.000002', peak_pricing: { multiplier: 2 } },
        }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000002000000', completion: '0.000004000000' });
  });

  it('includes long-context overrides in the worst case', () => {
    expect(
      getProviderDisplayPricing(
        'openai',
        {
          prompt: '0.000008',
          completion: '0.00004',
          overrides: [{ min_prompt_tokens: 272000, prompt: '0.000016', completion: '0.00006' }],
        },
        vercelModel({ provider: 'openai', pricing: { prompt: '0.000007', completion: '0.00003' } }),
        'worstCase'
      )
    ).toEqual({ prompt: '0.000016', completion: '0.00006' });
  });

  it("shows Vercel's first price tier and, in the worst case, its highest", () => {
    const vercel = vercelModel({
      provider: 'alibaba',
      pricing: {
        prompt: '0.0000005',
        completion: '0.000003',
        prompt_tiers: [
          { cost: '0.0000005', min: 0, max: 256000 },
          { cost: '0.000002', min: 256000 },
        ],
        completion_tiers: [
          { cost: '0.000003', min: 0, max: 256000 },
          { cost: '0.000006', min: 256000 },
        ],
      },
    });
    const openRouterPricing = { prompt: '0.0000004', completion: '0.0000025' };

    expect(getProviderDisplayPricing('alibaba', openRouterPricing, vercel, 'shortContext')).toEqual(
      {
        prompt: '0.0000005',
        completion: '0.000003',
      }
    );
    expect(getProviderDisplayPricing('alibaba', openRouterPricing, vercel, 'worstCase')).toEqual({
      prompt: '0.000002',
      completion: '0.000006',
    });
  });

  it('returns only the OpenRouter display price without a provider to match', () => {
    expect(
      getProviderDisplayPricing(
        undefined,
        { prompt: '0.000001', completion: '0.000002', discount: 0.5 },
        vercelModel({ provider: 'novita', pricing: { prompt: '1', completion: '1' } }),
        'shortContext'
      )
    ).toEqual({ prompt: '0.000002000000', completion: '0.000004000000' });
  });
});

describe('getVercelModelForPricing', () => {
  const model = vercelModel({ provider: 'zai', pricing: { prompt: '1', completion: '1' } });
  const vercel = (models: Record<string, GatewayModelWithEndpoints>, overrides = new Map()) => ({
    models,
    overrides,
  });

  it('maps the OpenRouter model prefix to the Vercel one', () => {
    expect(getVercelModelForPricing(vercel({ 'zai/glm-5': model }), 'z-ai/glm-5')).toBe(model);
  });

  it('keeps ids that need no mapping', () => {
    expect(getVercelModelForPricing(vercel({ 'vendor/model': model }), 'vendor/model')).toBe(model);
  });

  it('uses a model id override', () => {
    expect(
      getVercelModelForPricing(
        vercel({ 'vendor/other-name': model }, new Map([['vendor/model', 'vendor/other-name']])),
        'vendor/model'
      )
    ).toBe(model);
  });

  it('returns undefined for a model Vercel does not list', () => {
    expect(getVercelModelForPricing(vercel({ 'vendor/model': model }), 'vendor/unknown')).toBe(
      undefined
    );
    expect(getVercelModelForPricing(EMPTY_VERCEL_PRICING_METADATA, 'vendor/model')).toBe(undefined);
  });

  it('does not read inherited object properties', () => {
    expect(getVercelModelForPricing(vercel({}), 'constructor')).toBe(undefined);
  });

  it('returns undefined for a free model, whatever Vercel charges for its paid sibling', () => {
    expect(
      getVercelModelForPricing(
        vercel({ 'zai/glm-5': model, 'zai/glm-5:free': model }),
        'z-ai/glm-5:free'
      )
    ).toBe(undefined);
  });
});
