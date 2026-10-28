import type { StoredModel } from '@kilocode/db';
import type {
  OpenRouterModel,
  OpenRouterModelsResponse,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getRawOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { getPreferredProviderOrderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config';
import { enforceRequestCostLimit } from '@kilocode/web-shared/lib/ai-gateway/request-cost-limit';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import {
  kiloExclusiveModelFixture,
  useKiloExclusiveModel,
} from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';
import { briefingPriceBound } from './summary';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/openrouter'),
  getRawOpenRouterModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/unavailable-models', () => ({
  getUnavailableModelIds: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing-config', () => ({
  getCustomPricingConfig: jest.fn(),
}));

function catalogModel(id: string, pricing: OpenRouterModel['pricing']): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false },
    pricing,
    context_length: 128_000,
  };
}

describe('briefing model pricing', () => {
  useKiloExclusiveModel();

  const aion = catalogModel('aion-labs/aion-3.5-mini', {
    prompt: '0.0000007',
    completion: '0.0000014',
  });

  beforeEach(() => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    jest.mocked(getUnavailableModelIds).mockResolvedValue(new Set<string>());
    jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({ rules: [] });
    jest.mocked(getCustomPricingConfig).mockResolvedValue(TEST_CUSTOM_PRICING_CONFIG);
    jest
      .mocked(getRawOpenRouterModels)
      .mockResolvedValue({ data: [aion] } satisfies OpenRouterModelsResponse);
  });

  it('quotes the custom pricing tier that applies at the input token bound', async () => {
    const tier = (start_context_length: number, prompt_per_million: number) => ({
      start_context_length,
      pricing: {
        prompt_per_million,
        completion_per_million: prompt_per_million * 2,
        input_cache_read_per_million: null,
        input_cache_write_per_million: null,
      },
    });
    jest.mocked(getCustomPricingConfig).mockResolvedValue({
      models: [{ model: aion.id, pricing: [tier(0, 1), tier(5_000, 10)] }],
    });
    const longPrompt = 'x'.repeat(1_000);

    const shortQuote = await briefingPriceBound(aion.id, 'Overnight activity', 2_000_000);
    const longQuote = await briefingPriceBound(aion.id, longPrompt, 2_000_000);

    // Null cache prices bill at the prompt price, and the input rate adds the worse cache rate.
    expect(shortQuote.inputRate).toBe(0.000002);
    expect(shortQuote.outputRate).toBe(0.000002);
    expect(longQuote.inputRate).toBe(0.00002);
    expect(longQuote.outputRate).toBe(0.00002);
    await expect(
      enforceRequestCostLimit(
        String(longQuote.upperBound),
        aion.id,
        {
          messages: [{ role: 'user', content: longPrompt }],
          max_tokens: longQuote.maxTokens,
          stream: false,
        },
        2_000_000,
        { id: 'openrouter', userFunded: false }
      )
    ).resolves.toMatchObject({ refusal: null });
  });

  it('quotes a model the picker prices even when the snapshot does not carry it', async () => {
    const quote = await briefingPriceBound(aion.id, 'Overnight activity', 2_000_000);

    expect(quote.inputRate).toBe(0.0000007);
    expect(quote.outputRate).toBe(0.0000014);
    expect(quote.estimatedCost).toBeGreaterThan(0);
    expect(quote.upperBound).toBeLessThanOrEqual(2_000_000);
    await expect(
      enforceRequestCostLimit(
        String(quote.upperBound),
        aion.id,
        {
          messages: [{ role: 'user', content: 'Overnight activity' }],
          max_tokens: quote.maxTokens,
          stream: false,
        },
        2_000_000,
        { id: 'openrouter', userFunded: false }
      )
    ).resolves.toMatchObject({ refusal: null });
    await expect(briefingPriceBound(aion.id, 'Overnight activity', 1)).rejects.toThrow(
      'spend_limit_too_low'
    );
  });

  it('leaves a reasoning model output room for reasoning before the answer within the spend limit', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      [aion.id]: {
        id: aion.id,
        name: aion.name,
        reasoning: { mandatory: false, supported_efforts: ['low'] },
        endpoints: [{ pricing: { prompt: '0.000001', completion: '0.000002' } }],
      } satisfies StoredModel,
    });

    const roomy = await briefingPriceBound(aion.id, 'Overnight activity', 2_000_000);
    expect(roomy.maxTokens).toBeGreaterThan(8192);
    expect(roomy.upperBound).toBeLessThanOrEqual(2_000_000);
    const tight = await briefingPriceBound(aion.id, 'Overnight activity', 20_000);
    expect(tight.maxTokens).toBeLessThan(roomy.maxTokens);
    expect(tight.upperBound).toBeLessThanOrEqual(20_000);
  });

  it('keeps a model without reasoning within the output limit every model accepts', async () => {
    const quote = await briefingPriceBound(aion.id, 'Overnight activity', 2_000_000);
    expect(quote.maxTokens).toBeLessThanOrEqual(2048);
  });

  it('quotes the configured preferred route rather than the first endpoint or catalog price', async () => {
    jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({
      rules: [{ includes: ['aion-labs/'], providers: ['preferred-route'] }],
    });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      [aion.id]: {
        id: aion.id,
        name: aion.name,
        endpoints: [
          { tag: 'other-route', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
          { tag: 'preferred-route', pricing: { prompt: '0.000002', completion: '0.000004' } },
        ],
      } satisfies StoredModel,
    });

    const quote = await briefingPriceBound(aion.id, 'Overnight activity', 2_000_000);

    expect(quote.inputRate).toBe(0.000002);
    expect(quote.outputRate).toBe(0.000004);
    expect(quote.estimatedCost).toBe(11_300);
    await expect(
      enforceRequestCostLimit(
        String(quote.upperBound),
        aion.id,
        {
          messages: [{ role: 'user', content: 'Overnight activity' }],
          max_tokens: quote.maxTokens,
          stream: false,
        },
        2_000_000,
        { id: 'openrouter', userFunded: false }
      )
    ).resolves.toMatchObject({ refusal: null });
  });

  it('rejects a model the picker does not price', async () => {
    await expect(
      briefingPriceBound('vendor/unlisted', 'Overnight activity', 2_000_000)
    ).rejects.toThrow('model_pricing_unavailable');
  });

  it('refuses a model the gateway marks unavailable', async () => {
    jest.mocked(getUnavailableModelIds).mockResolvedValue(new Set([aion.id]));

    await expect(briefingPriceBound(aion.id, 'Overnight activity', 2_000_000)).rejects.toThrow(
      'model_not_allowed'
    );
  });

  it('refuses a priced catalog model the picker hides when a snapshot exists', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      'vendor/listed': {
        id: 'vendor/listed',
        name: 'Listed',
        endpoints: [{ pricing: { prompt: '0.000001', completion: '0.000002' } }],
      } satisfies StoredModel,
    });

    await expect(briefingPriceBound(aion.id, 'Overnight activity', 2_000_000)).rejects.toThrow(
      'model_not_allowed'
    );
  });

  it('refuses a batch variant the picker never lists', async () => {
    const batch = catalogModel('aion-labs/aion-3.5-mini:batch', {
      prompt: '0.00000035',
      completion: '0.0000007',
    });
    jest
      .mocked(getRawOpenRouterModels)
      .mockResolvedValue({ data: [batch] } satisfies OpenRouterModelsResponse);

    await expect(briefingPriceBound(batch.id, 'Overnight activity', 2_000_000)).rejects.toThrow(
      'model_not_allowed'
    );
  });

  it('quotes a picker-built entry at its own price, ignoring a same-id catalog row and snapshot route', async () => {
    const exclusive = catalogModel(kiloExclusiveModelFixture.public_id, {
      prompt: '0.00001',
      completion: '0.00002',
    });
    jest
      .mocked(getRawOpenRouterModels)
      .mockResolvedValue({ data: [exclusive] } satisfies OpenRouterModelsResponse);

    const withCatalogRow = await briefingPriceBound(exclusive.id, 'Overnight activity', 2_000_000);

    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [] });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      [exclusive.id]: {
        id: exclusive.id,
        name: exclusive.name,
        endpoints: [{ tag: 'alibaba', pricing: { prompt: '0.001', completion: '0.002' } }],
      } satisfies StoredModel,
    });

    expect(withCatalogRow).toEqual(
      await briefingPriceBound(exclusive.id, 'Overnight activity', 2_000_000)
    );
    expect(withCatalogRow.inputRate).toBeLessThan(Number(exclusive.pricing.prompt));
  });

  it('rejects a picker price with unknown rates', async () => {
    await expect(
      briefingPriceBound('kilo-auto/frontier', 'Overnight activity', 2_000_000)
    ).rejects.toThrow('invalid_model_pricing');
  });

  it('quotes a free picker model at zero and admits it without a route price cap', async () => {
    const freeModel = 'google/gemma-4-26b-a4b-it:free';
    const quote = await briefingPriceBound(freeModel, 'Overnight activity', 2_000_000);

    expect(quote.inputRate).toBe(0);
    expect(quote.outputRate).toBe(0);
    expect(quote.upperBound).toBe(0);
    await expect(
      enforceRequestCostLimit(
        '2000000',
        freeModel,
        {
          messages: [{ role: 'user', content: 'Overnight activity' }],
          max_tokens: quote.maxTokens,
          stream: false,
        },
        2_000_000,
        { id: 'vercel', userFunded: false }
      )
    ).resolves.toMatchObject({ refusal: null });
  });

  it('bounds a latest alias by the price of the target it resolves to', async () => {
    const alias = catalogModel('~deepseek/deepseek-flash-latest', {
      prompt: '0.000000049',
      completion: '0.000000375',
    });
    const target = catalogModel('deepseek/deepseek-v4.1-flash', {
      prompt: '0.0000001',
      completion: '0.0000004',
    });
    jest
      .mocked(getRawOpenRouterModels)
      .mockResolvedValue({ data: [alias, target] } satisfies OpenRouterModelsResponse);
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      [alias.id]: {
        id: alias.id,
        name: alias.name,
        alias_target: { slug: target.id },
        endpoints: [],
      } satisfies StoredModel,
    });

    const quote = await briefingPriceBound(alias.id, 'Overnight activity', 2_000_000);

    expect(quote.inputRate).toBe(0.0000001);
    expect(quote.outputRate).toBe(0.0000004);
  });
  it('keeps a missing alias target unavailable in both the quote and gateway admission', async () => {
    const alias = catalogModel('~vendor/model-latest', {
      prompt: '0.0000001',
      completion: '0.0000002',
    });
    const targetId = 'vendor/model';
    jest
      .mocked(getRawOpenRouterModels)
      .mockResolvedValue({ data: [alias] } satisfies OpenRouterModelsResponse);
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      [alias.id]: {
        id: alias.id,
        name: alias.name,
        alias_target: { slug: targetId },
        endpoints: [],
      } satisfies StoredModel,
    });

    await expect(briefingPriceBound(alias.id, 'Overnight activity', 2_000_000)).rejects.toThrow(
      'model_pricing_unavailable'
    );
    await expect(
      enforceRequestCostLimit(
        '2000000',
        alias.id,
        {
          model: alias.id,
          messages: [{ role: 'user', content: 'Overnight activity' }],
          max_tokens: 64,
          stream: false,
        },
        2_000_000,
        { id: 'openrouter', userFunded: false }
      )
    ).resolves.toMatchObject({
      refusal: expect.stringMatching(/pricing/),
      providerConfig: null,
    });
  });
});
