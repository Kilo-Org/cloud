import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  formatName,
  getEnhancedOpenRouterModels,
  getOpenRouterTranscriptionModels,
  shouldSuppressOpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter';
import { createMockResponse, mockOpenRouterModels } from '@/tests/helpers/openrouter-models.helper';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { qwen36_plus_stealth_model, qwen38_max_model } from '@/lib/ai-gateway/providers/qwen';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/providers/google';
import {
  findKiloExclusiveModel,
  isDeadFreeModel,
  kiloExclusiveModels,
} from '@/lib/ai-gateway/models';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { isFableModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import { KILO_AUTO_EFFICIENT_MODEL } from '@/lib/ai-gateway/auto-model';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(() => Promise.resolve({})),
}));

const originalFetch = global.fetch;

const disabledPaidModel = {
  ...qwen36_plus_stealth_model,
  public_id: 'vendor/disabled-paid-model',
  internal_id: 'vendor/disabled-paid-model-internal',
  display_name: 'Disabled Paid Kilo Model',
  status: 'disabled',
} satisfies KiloExclusiveModel;

const disabledFreeModel = {
  ...qwen36_plus_stealth_model,
  public_id: 'vendor/disabled-free-model',
  internal_id: 'vendor/disabled-free-model-internal',
  display_name: 'Disabled Free Kilo Model',
  status: 'disabled',
  pricing: null,
} satisfies KiloExclusiveModel;

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

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-17T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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

  it('appends the retirement date in UTC when it is within one month', () => {
    const model = buildModel({ expiration_date: '2026-07-01' });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model (retires Jul 1)');
  });

  it('does not append the retirement date when it is more than one month away', () => {
    const model = buildModel({ expiration_date: '2026-07-18' });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model');
  });

  it('prefers the (new) marker over the retirement marker', () => {
    const recentlyCreated = Math.floor(Date.now() / 1000) - 24 * 3600;
    const model = buildModel({ created: recentlyCreated, expiration_date: '2026-07-01' });
    expect(formatName(model, 0)).toBe('Test Model (new)');
  });

  it('returns the name unchanged when no markers apply', () => {
    const model = buildModel({ created: 0 });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model');
  });

  it('prefixes the name with OpenRouter for openrouter/ models without it', () => {
    const model = buildModel({ id: 'openrouter/auto', created: 0 });
    expect(formatName(model, NOT_PREFERRED)).toBe('OpenRouter Test Model');
  });

  it('does not prefix the name when it already contains OpenRouter', () => {
    const model = buildModel({ id: 'openrouter/auto', name: 'OpenRouter Test Model', created: 0 });
    expect(formatName(model, NOT_PREFERRED)).toBe('OpenRouter Test Model');
  });

  it('does not prefix the name for non-openrouter/ models', () => {
    const model = buildModel({ id: 'vendor/model', created: 0 });
    expect(formatName(model, NOT_PREFERRED)).toBe('Test Model');
  });

  it('prefixes the name before appending markers', () => {
    const model = buildModel({
      id: 'openrouter/auto',
      pricing: { prompt: '0.00001', completion: '0' },
    });
    expect(formatName(model, NOT_PREFERRED)).toBe('OpenRouter Test Model ($$$$)');
  });
});

describe('shouldSuppressOpenRouterModel', () => {
  it('does not suppress disabled paid Kilo-exclusive models returned by OpenRouter', () => {
    expect(disabledPaidModel.pricing).not.toBeNull();
    expect(shouldSuppressOpenRouterModel(disabledPaidModel)).toBe(false);
  });

  it('suppresses disabled free Kilo-exclusive models from OpenRouter', () => {
    expect(disabledFreeModel.status).toBe('disabled');
    expect(disabledFreeModel.pricing).toBeNull();
    expect(shouldSuppressOpenRouterModel(disabledFreeModel)).toBe(true);
  });

  it('suppresses hidden Kilo-exclusive models from OpenRouter', () => {
    expect(gemma_4_26b_a4b_it_free_model.status).toBe('hidden');
    expect(shouldSuppressOpenRouterModel(gemma_4_26b_a4b_it_free_model)).toBe(true);
  });
});

describe('isFableModel', () => {
  it('only matches Claude Fable model IDs', () => {
    expect(isFableModel('anthropic/claude-fable-5')).toBe(true);
    expect(isFableModel('vendor/fable-model')).toBe(false);
  });
});

describe('auto models', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: { data: [] },
        })
      )
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('includes kilo-auto/efficient in the public model list', async () => {
    const models = await getEnhancedOpenRouterModels();

    expect(models.data.some(model => model.id === KILO_AUTO_EFFICIENT_MODEL.id)).toBe(true);
  });

  it('excludes OpenRouter batch variants from the public model list', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [buildModel(), buildModel({ id: 'vendor/model:batch' })],
          },
        })
      )
    ) as unknown as typeof fetch;

    const models = await getEnhancedOpenRouterModels();

    expect(models.data.some(model => model.id === 'vendor/model')).toBe(true);
    expect(models.data.some(model => model.id === 'vendor/model:batch')).toBe(false);
  });

  it('replaces the conventional OpenRouter Qwen 3.8 ID with the requested Kilo alias', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [buildModel({ id: 'qwen/qwen3.8-max', name: 'OpenRouter Qwen 3.8 Max' })],
          },
        })
      )
    ) as unknown as typeof fetch;

    const models = await getEnhancedOpenRouterModels();

    expect(models.data.filter(model => model.id === 'qwen/qwen3.8-max')).toHaveLength(0);
    expect(models.data.filter(model => model.id === qwen38_max_model.public_id)).toHaveLength(1);
    expect(models.data.find(model => model.id === qwen38_max_model.public_id)).toMatchObject({
      name: qwen38_max_model.display_name,
      pricing: {
        prompt: '0.000002000000',
        completion: '0.000006000000',
      },
    });
  });
});

describe('disabled paid Kilo-exclusive model fallback', () => {
  beforeEach(() => {
    kiloExclusiveModels.push(disabledPaidModel);
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: { data: [buildModel({ id: disabledPaidModel.public_id })] },
        })
      )
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    const modelIndex = kiloExclusiveModels.indexOf(disabledPaidModel);
    if (modelIndex >= 0) kiloExclusiveModels.splice(modelIndex, 1);
    global.fetch = originalFetch;
  });

  it('keeps the OpenRouter model available without Kilo-exclusive blocking or routing', async () => {
    const models = await getEnhancedOpenRouterModels();

    expect(models.data.some(model => model.id === disabledPaidModel.public_id)).toBe(true);
    expect(isDeadFreeModel(disabledPaidModel.public_id)).toBe(false);
    expect(findKiloExclusiveModel(disabledPaidModel.public_id)).toBeNull();
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
