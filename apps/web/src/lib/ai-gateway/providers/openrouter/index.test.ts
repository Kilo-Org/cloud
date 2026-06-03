import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  formatName,
  getOpenRouterTranscriptionModels,
  undoPricingDiscount,
} from '@/lib/ai-gateway/providers/openrouter';
import { createMockResponse, mockOpenRouterModels } from '@/tests/helpers/openrouter-models.helper';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

const originalFetch = global.fetch;

function buildModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: 'vendor/model',
    name: 'Test Model',
    created: 1714000000,
    description: 'A test model',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'other',
    },
    top_provider: {
      is_moderated: false,
    },
    pricing: {
      prompt: '0.000001',
      completion: '0.000005',
    },
    context_length: 32000,
    ...overrides,
  };
}

describe('formatName', () => {
  const NOT_PREFERRED = -1;

  it('appends ($$$$) for expensive models', () => {
    const model = buildModel({ pricing: { prompt: '0.00001', completion: '0' } });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model ($$$$)');
  });

  it('prioritizes the expensive marker over the expiration marker', () => {
    const model = buildModel({
      pricing: { prompt: '0.00002', completion: '0' },
      expiration_date: '2099-01-15',
    });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model ($$$$)');
  });

  it('leaves names that already end with a parenthesis untouched', () => {
    const model = buildModel({
      name: 'Test Model (free)',
      expiration_date: '2099-01-15',
    });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model (free)');
  });

  it('appends (new) for recently created preferred models', () => {
    const recentlyCreated = Math.floor(Date.now() / 1000) - 24 * 3600;
    const model = buildModel({ created: recentlyCreated });
    expect(formatName(model, 0)).toBe('Test Model (new)');
  });

  it('does not mark recent models as new when they are not preferred', () => {
    const recentlyCreated = Math.floor(Date.now() / 1000) - 24 * 3600;
    const model = buildModel({ created: recentlyCreated });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model');
  });

  it('does not mark older preferred models as new', () => {
    const createdLongAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const model = buildModel({ created: createdLongAgo });
    expect(formatName(model, 0)).toBe('Test Model');
  });

  it('appends the retirement date in UTC when an expiration date is set', () => {
    const model = buildModel({ expiration_date: '2026-12-01' });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model (retires Dec 1)');
  });

  it('prefers the (new) marker over the retirement marker', () => {
    const recentlyCreated = Math.floor(Date.now() / 1000) - 24 * 3600;
    const model = buildModel({ created: recentlyCreated, expiration_date: '2026-12-01' });
    expect(formatName(model, 0)).toBe('Test Model (new)');
  });

  it('returns the name unchanged when no markers apply', () => {
    const model = buildModel({ created: 0 });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model');
  });
});

describe('undoPricingDiscount', () => {
  it('reverses the discount and drops the field without exponential output', () => {
    const result = undoPricingDiscount({
      prompt: '0.00000006',
      completion: '0.0000006',
      input_cache_read: '0.000000015',
      discount: 0.7,
    });
    expect(result).toEqual({
      prompt: '0.000000200000',
      completion: '0.000002000000',
      input_cache_read: '0.000000050000',
    });
    expect('discount' in result).toBe(false);
    for (const value of Object.values(result)) {
      expect(value).not.toMatch(/e/i);
    }
  });

  it('leaves pricing untouched when there is no discount', () => {
    const pricing = { prompt: '0.000001', completion: '0.000005' };
    expect(undoPricingDiscount(pricing)).toBe(pricing);
  });

  it('leaves pricing untouched when the discount is zero', () => {
    const pricing = { prompt: '0.000001', completion: '0.000005', discount: 0 };
    expect(undoPricingDiscount(pricing)).toBe(pricing);
  });

  it('drops the field when the discount cannot be reversed', () => {
    const result = undoPricingDiscount({
      prompt: '0.000001',
      completion: '0.000005',
      discount: 1,
    });
    expect(result).toEqual({ prompt: '0.000001', completion: '0.000005' });
  });
});

describe('OpenRouter transcription model fetcher', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: mockOpenRouterModels,
        })
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches transcription models with output_modalities=transcription', async () => {
    await getOpenRouterTranscriptionModels();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('output_modalities=transcription'),
      expect.any(Object)
    );
  });
});
