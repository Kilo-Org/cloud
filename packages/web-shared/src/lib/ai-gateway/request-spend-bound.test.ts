import { beforeEach, describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getOpenRouterModelsMetadataFromDatabase } from './providers/gateway-models-cache';
import { getRawModelCatalog } from './providers/raw-model-catalog';
import { getPreferredProviderOrderConfig } from './providers/preferred-provider-order-config';
import { getCustomPricingConfig } from './custom-pricing-config';
import { embeddingRequestSpendBound, textRequestSpendBound } from './request-spend-bound';

jest.mock('./providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));
jest.mock('./providers/raw-model-catalog', () => ({
  getRawModelCatalog: jest.fn(),
}));
jest.mock('./providers/preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn(),
}));
jest.mock('./custom-pricing-config', () => ({
  getCustomPricingConfig: jest.fn(),
}));

const MODEL_ID = 'test/spend-bound';

const STORED_MODEL: StoredModel = {
  id: MODEL_ID,
  name: 'Spend bound model',
  endpoints: [
    {
      tag: 'first-route',
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
  ],
};

function catalogEntry(maxCompletionTokens: number | null): OpenRouterModel {
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    created: 0,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false, max_completion_tokens: maxCompletionTokens },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    context_length: 128_000,
  };
}

/**
 * At these prices every input token costs 1 µUSD and every output token 2 µUSD.
 * A request carrying `abcd` as the only user content has 8 input tokens' worth of
 * string values (`user`, `abcd`), plus the bound's 2048-token allowance.
 */
const REQUEST_INPUT_MICRODOLLARS = (8 + 2048) * 1;

beforeEach(() => {
  jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
    [MODEL_ID]: STORED_MODEL,
  });
  jest.mocked(getRawModelCatalog).mockResolvedValue([catalogEntry(8_192)]);
  jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({ rules: [] });
  jest.mocked(getCustomPricingConfig).mockResolvedValue({ models: [] });
});

describe('textRequestSpendBound', () => {
  it('prices the output ceiling the request states', async () => {
    const body = { messages: [{ role: 'user', content: 'abcd' }], max_tokens: 100 };

    await expect(
      textRequestSpendBound({ model: MODEL_ID, body, explicitOutputTokens: 100 })
    ).resolves.toBe(REQUEST_INPUT_MICRODOLLARS + 100 * 2);
  });

  it('prices every requested choice against its own ceiling', async () => {
    const body = { messages: [{ role: 'user', content: 'abcd' }], max_tokens: 100 };

    await expect(
      textRequestSpendBound({ model: MODEL_ID, body, explicitOutputTokens: 100, choices: 3 })
    ).resolves.toBe(REQUEST_INPUT_MICRODOLLARS + 300 * 2);
  });

  it('falls back to the catalog ceiling when the request states none', async () => {
    const body = { messages: [{ role: 'user', content: 'abcd' }] };

    await expect(
      textRequestSpendBound({ model: MODEL_ID, body, explicitOutputTokens: null })
    ).resolves.toBe(REQUEST_INPUT_MICRODOLLARS + 8_192 * 2);
  });

  it('reports no bound when neither the request nor the catalog states a ceiling', async () => {
    jest.mocked(getRawModelCatalog).mockResolvedValue([catalogEntry(null)]);

    await expect(
      textRequestSpendBound({
        model: MODEL_ID,
        body: { messages: [{ role: 'user', content: 'abcd' }] },
        explicitOutputTokens: null,
      })
    ).resolves.toBeNull();
  });

  it('reports no bound for a model no price source knows', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    jest.mocked(getRawModelCatalog).mockResolvedValue([]);

    await expect(
      textRequestSpendBound({
        model: 'missing/model',
        body: { messages: [{ role: 'user', content: 'abcd' }] },
        explicitOutputTokens: 100,
      })
    ).resolves.toBeNull();
  });

  it('reports no bound when the catalog cannot be read', async () => {
    jest.mocked(getRawModelCatalog).mockRejectedValue(new Error('catalog unavailable'));

    await expect(
      textRequestSpendBound({
        model: MODEL_ID,
        body: { messages: [{ role: 'user', content: 'abcd' }] },
        explicitOutputTokens: 100,
      })
    ).resolves.toBeNull();
  });
});

describe('embeddingRequestSpendBound', () => {
  it('prices the input of an embedding request and no output', async () => {
    const body = { model: MODEL_ID, input: 'abcd' };

    // The model id and the input are the request's only string values: 20 tokens.
    await expect(embeddingRequestSpendBound({ model: MODEL_ID, body })).resolves.toBe(
      (20 + 2048) * 1
    );
  });
});
