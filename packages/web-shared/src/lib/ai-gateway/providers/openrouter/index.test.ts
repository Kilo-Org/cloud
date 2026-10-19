import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  buildAutoModelCatalogEntry,
  formatName,
  getEnhancedOpenRouterModels,
  getOpenRouterTranscriptionModels,
  getRawOpenRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import type { StoredModel } from '@kilocode/db/schema-types';
import {
  createMockResponse,
  mockOpenRouterModels,
} from '@kilocode/web-shared/tests/helpers/openrouter-models.helper';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { qwen36_plus_stealth_model } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { gemma_4_26b_a4b_it_free_model } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  findKiloExclusiveModel,
  kiloExclusiveModels,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { getInferenceProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  AUTO_MODELS,
  KILO_AUTO_EFFICIENT_MODEL,
  ORG_AUTO_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  getDataCollectionRequiredModelIds,
  getProviderSlugsForModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { OpenRouterModelsResponseSchema } from '@kilocode/web-shared/lib/organizations/organization-types';
import type * as UnavailableModelsModule from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';

jest.mock('@kilocode/web-shared/lib/ai-gateway/unavailable-models', () => {
  const actual = jest.requireActual<typeof UnavailableModelsModule>(
    '@kilocode/web-shared/lib/ai-gateway/unavailable-models'
  );
  return { ...actual, getUnavailableModelIds: jest.fn(actual.getUnavailableModelIds) };
});

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(() => Promise.resolve({})),
}));

jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    getDataCollectionRequiredModelIds: jest.fn(() => Promise.resolve(new Set())),
    getProviderSlugsForModels: jest.fn((ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map(id => [id, new Set<string>()])))
    ),
  })
);

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

describe('auto models', () => {
  beforeEach(() => {
    jest
      .mocked(getProviderSlugsForModels)
      .mockImplementation(async ids => new Map(ids.map(id => [id, new Set<string>()])));
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: { data: [] },
        })
      )
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    global.fetch = originalFetch;
  });

  it('includes kilo-auto/efficient in the public model list', async () => {
    const models = await getEnhancedOpenRouterModels();

    expect(models.data.some(model => model.id === KILO_AUTO_EFFICIENT_MODEL.id)).toBe(true);
  });

  it('explicitly caches authenticated catalog requests', async () => {
    await getEnhancedOpenRouterModels();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ cache: 'force-cache', next: { revalidate: 60 } })
    );
  });

  it.each([undefined, { name: 'Current model', slug: 'vendor/current' }])(
    'validates raw upstream models with alias_target %j without falling back to unparsed data',
    async aliasTarget => {
      global.fetch = jest.fn(() =>
        Promise.resolve(
          createMockResponse({
            jsonData: {
              data: [
                {
                  ...buildModel({ id: '~vendor/latest' }),
                  alias_target: aliasTarget,
                  canonical_slug: '~vendor/latest',
                },
              ],
            },
          })
        )
      ) as typeof fetch;

      const response = await getRawOpenRouterModels();
      expect(response.data[0]?.id).toBe('~vendor/latest');
      expect(response.data[0]?.alias_target).toBeUndefined();
      expect(response.data[0]).not.toHaveProperty('canonical_slug');
    }
  );

  it.each(['~vendor/latest', 'vendor/concrete'])(
    'does not publish an upstream alias target for %s without database alias metadata',
    async modelId => {
      global.fetch = jest.fn(() =>
        Promise.resolve(
          createMockResponse({
            jsonData: {
              data: [buildModel({ id: modelId, alias_target: 'vendor/upstream-only' })],
            },
          })
        )
      ) as typeof fetch;

      const response = await getEnhancedOpenRouterModels();
      const model = response.data.find(entry => entry.id === modelId);
      expect(model).toBeDefined();
      expect(model?.alias_target).toBeUndefined();
      expect(JSON.parse(JSON.stringify(model))).not.toHaveProperty('alias_target');
    }
  );

  it('publishes database alias targets only for alias entries and preserves them through validation', async () => {
    const alias = buildModel({ id: '~vendor/latest' });
    const target = buildModel({ id: 'vendor/current' });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValueOnce({
      [alias.id]: {
        ...alias,
        endpoints: [],
        alias_target: { slug: target.id },
      },
      [target.id]: {
        ...target,
        endpoints: [],
        alias_target: { slug: 'vendor/ignored' },
      },
    });
    jest
      .mocked(getProviderSlugsForModels)
      .mockImplementation(
        async ids =>
          new Map(
            ids.map(id => [
              id,
              id === target.id
                ? new Set(['Google-Vertex', 'google-ai-studio'])
                : new Set(['deepinfra']),
            ])
          )
      );
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [
              { ...alias, alias_target: { name: 'Upstream model', slug: 'vendor/upstream' } },
              { ...target, alias_target: 'vendor/upstream' },
            ],
          },
        })
      )
    ) as unknown as typeof fetch;

    const response = OpenRouterModelsResponseSchema.parse(await getEnhancedOpenRouterModels());
    expect(response.data.find(model => model.id === alias.id)?.alias_target).toBe(target.id);
    expect(response.data.find(model => model.id === target.id)?.alias_target).toBeUndefined();
    expect(response.data.find(model => model.id === alias.id)?.inference_provider_ids).toEqual([
      'google-vertex',
      'google-ai-studio',
    ]);
    expect(response.data.find(model => model.id === target.id)?.inference_provider_ids).toEqual([
      'google-vertex',
      'google-ai-studio',
    ]);
  });

  it('publishes normalized endpoint identities and preserves the public schema field', async () => {
    jest.mocked(getProviderSlugsForModels).mockClear();
    jest
      .mocked(getProviderSlugsForModels)
      .mockImplementation(
        async ids =>
          new Map(
            ids.map(id => [id, new Set(['DeepInfra/fp8', 'Fireworks', 'Together', 'deepinfra'])])
          )
      );
    global.fetch = jest.fn(() =>
      Promise.resolve(createMockResponse({ jsonData: { data: [buildModel()] } }))
    ) as typeof fetch;

    const response = OpenRouterModelsResponseSchema.parse(await getEnhancedOpenRouterModels());
    expect(
      response.data.find(model => model.id === 'vendor/model')?.inference_provider_ids
    ).toEqual(['deepinfra', 'fireworks', 'together']);
    expect(getProviderSlugsForModels).toHaveBeenCalledTimes(1);
  });

  it('does not infer an upstream from the model author when metadata is missing', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(createMockResponse({ jsonData: { data: [buildModel()] } }))
    ) as typeof fetch;

    const response = await getEnhancedOpenRouterModels();
    expect(
      response.data.find(model => model.id === 'vendor/model')?.inference_provider_ids
    ).toEqual([]);
  });

  it('publishes authoritative exclusive model inference providers', async () => {
    const response = await getEnhancedOpenRouterModels();
    const unavailableModelIds = await getUnavailableModelIds();
    const models = kiloExclusiveModels.filter(model => !unavailableModelIds.has(model.public_id));
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const providers = getInferenceProviders(model);
      if (providers.length === 0) continue;
      expect(
        response.data.find(entry => entry.id === model.public_id)?.inference_provider_ids
      ).toEqual(providers.map(({ slug }) => slug));
    }
  });

  it('lists every exclusive model except unavailable ones', async () => {
    jest
      .mocked(getUnavailableModelIds)
      .mockResolvedValueOnce(new Set([qwen36_plus_stealth_model.public_id]));

    const models = await getEnhancedOpenRouterModels();

    expect(models.data.some(model => model.id === qwen36_plus_stealth_model.public_id)).toBe(false);
    for (const model of kiloExclusiveModels) {
      if (model === qwen36_plus_stealth_model) continue;
      expect(models.data.some(entry => entry.id === model.public_id)).toBe(true);
    }
  });

  it('hides the hard-coded unavailable Gemma model', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: { data: [buildModel({ id: gemma_4_26b_a4b_it_free_model.public_id })] },
        })
      )
    ) as unknown as typeof fetch;

    const models = await getEnhancedOpenRouterModels();

    expect(models.data.some(model => model.id === gemma_4_26b_a4b_it_free_model.public_id)).toBe(
      false
    );
  });

  it('replaces an OpenRouter model that shares an exclusive public id', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [buildModel({ id: qwen36_plus_stealth_model.public_id, name: 'Upstream' })],
          },
        })
      )
    ) as unknown as typeof fetch;

    const models = await getEnhancedOpenRouterModels();
    const matches = models.data.filter(model => model.id === qwen36_plus_stealth_model.public_id);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).not.toBe('Upstream');
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
});

describe.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])(
  'OpenRouter catalog inheritance for %s',
  modelId => {
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('preserves the upstream metadata without duplicating or suppressing the free model', async () => {
      const catalogModel = buildModel({
        id: modelId,
        name: 'OpenRouter catalog name',
        pricing: { prompt: '0', completion: '0' },
      });
      global.fetch = jest.fn(() =>
        Promise.resolve(createMockResponse({ jsonData: { data: [catalogModel] } }))
      ) as typeof fetch;

      const models = await getEnhancedOpenRouterModels();
      const matches = models.data.filter(entry => entry.id === modelId);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ ...catalogModel, isFree: true });
      expect(findKiloExclusiveModel(modelId)).toBeNull();
    });

    it('does not inject the model when OpenRouter omits it', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve(createMockResponse({ jsonData: { data: [] } }))
      ) as typeof fetch;

      const models = await getEnhancedOpenRouterModels();

      expect(models.data.some(model => model.id === modelId)).toBe(false);
    });
  }
);

describe('reasoning variants', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('only adds fallback variants when reasoning is supported', async () => {
    const unsupportedId = 'anthropic/claude-without-reasoning';
    const supportedId = 'anthropic/claude-with-reasoning';
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [
              buildModel({
                id: unsupportedId,
                supported_parameters: ['max_tokens', 'tools'],
              }),
              buildModel({
                id: supportedId,
                supported_parameters: ['max_tokens', 'tools', 'reasoning'],
              }),
            ],
          },
        })
      )
    ) as unknown as typeof fetch;

    const models = await getEnhancedOpenRouterModels();

    expect(
      models.data.find(model => model.id === unsupportedId)?.opencode?.variants
    ).toBeUndefined();
    expect(models.data.find(model => model.id === supportedId)?.opencode?.variants).toBeDefined();
  });
});

describe('reasoning options', () => {
  const reasoningSupported = ['max_tokens', 'tools', 'reasoning', 'include_reasoning'];
  const openRouterReasoning: Record<string, StoredModel['reasoning']> = {
    'anthropic/claude-sonnet-4.6': {
      mandatory: false,
      supported_efforts: ['max', 'high', 'medium', 'low'],
    },
    'openai/gpt-5.5': {
      mandatory: false,
      supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'],
    },
    'google/gemini-3.1-pro-preview': {
      mandatory: true,
      supported_efforts: ['high', 'medium', 'low'],
    },
    'xiaomi/mimo-v2.5': { mandatory: false },
    'vendor/no-reasoning': undefined,
  };

  async function getCatalog() {
    jest
      .mocked(getOpenRouterModelsMetadataFromDatabase)
      .mockResolvedValue(
        Object.fromEntries(
          Object.entries(openRouterReasoning).map(([id, reasoning]) => [
            id,
            { id, name: id, reasoning, endpoints: [] },
          ])
        )
      );
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: Object.entries(openRouterReasoning).map(([id, reasoning]) =>
              buildModel({
                id,
                supported_parameters: reasoning ? reasoningSupported : ['max_tokens', 'tools'],
              })
            ),
          },
        })
      )
    ) as unknown as typeof fetch;
    const models = await getEnhancedOpenRouterModels();
    return (id: string) => models.data.find(model => model.id === id)?.opencode;
  }

  afterEach(() => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    global.fetch = originalFetch;
  });

  it('serves Anthropic efforts next to unchanged variants', async () => {
    const opencode = await getCatalog();

    expect(JSON.stringify(opencode('anthropic/claude-sonnet-4.6'))).toBe(
      JSON.stringify({
        ai_sdk_provider: 'anthropic',
        variants: {
          none: { reasoning: { enabled: false, effort: 'none' } },
          low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
          medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
          high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
          max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
        },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }],
      })
    );
  });

  it('serves OpenAI efforts', async () => {
    const opencode = await getCatalog();

    expect(opencode('openai/gpt-5.5')?.reasoning_options).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] },
    ]);
  });

  it('serves Gemini efforts without none when reasoning is mandatory', async () => {
    const opencode = await getCatalog();

    expect(opencode('google/gemini-3.1-pro-preview')?.reasoning_options).toEqual([
      { type: 'effort', values: ['low', 'medium', 'high'] },
    ]);
  });

  it('serves a toggle for models with on/off reasoning only', async () => {
    const opencode = await getCatalog();

    expect(Object.keys(opencode('xiaomi/mimo-v2.5')?.variants ?? {})).toEqual([
      'instant',
      'thinking',
    ]);
    expect(opencode('xiaomi/mimo-v2.5')?.reasoning_options).toEqual([{ type: 'toggle' }]);
  });

  it('omits reasoning options for models without variants', async () => {
    const opencode = await getCatalog();

    expect(opencode('vendor/no-reasoning')?.variants).toBeUndefined();
    expect(opencode('vendor/no-reasoning')?.reasoning_options).toBeUndefined();
  });

  it('omits reasoning options for kilo-auto models', async () => {
    const opencode = await getCatalog();

    for (const autoModel of AUTO_MODELS) {
      expect(opencode(autoModel.id)).toBeDefined();
      expect(opencode(autoModel.id)?.reasoning_options).toBeUndefined();
    }
    expect(buildAutoModelCatalogEntry(ORG_AUTO_MODEL).opencode?.reasoning_options).toBeUndefined();
  });

  it('pairs every non-auto model that has variants with reasoning options', async () => {
    const opencode = await getCatalog();

    for (const id of Object.keys(openRouterReasoning)) {
      const settings = opencode(id);
      expect(settings?.reasoning_options !== undefined).toBe(settings?.variants !== undefined);
    }
  });
});

describe('mayTrainOnYourPrompts', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('flags free models and models whose every provider trains on prompts', async () => {
    jest
      .mocked(getDataCollectionRequiredModelIds)
      .mockResolvedValueOnce(new Set(['meta/muse-spark-1.3-contributor']));
    global.fetch = jest.fn(() =>
      Promise.resolve(
        createMockResponse({
          jsonData: {
            data: [
              buildModel({ id: 'meta/muse-spark-1.3-contributor' }),
              buildModel({ id: 'meta/muse-spark-1.3' }),
              buildModel({ id: 'vendor/model:free', pricing: { prompt: '0', completion: '0' } }),
            ],
          },
        })
      )
    ) as unknown as typeof fetch;

    const models = await getEnhancedOpenRouterModels();
    const mayTrain = (id: string) =>
      models.data.find(model => model.id === id)?.mayTrainOnYourPrompts;

    expect(mayTrain('meta/muse-spark-1.3-contributor')).toBe(true);
    expect(mayTrain('meta/muse-spark-1.3')).toBe(false);
    expect(mayTrain('vendor/model:free')).toBe(true);
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

  it('never caches the transcription catalogue so an unreachable gateway surfaces as a failure', async () => {
    // The Data Cache would keep serving a stale catalogue while the gateway
    // is down, and the mobile picker would list dead models instead of its
    // load-failed retry state.
    await getOpenRouterTranscriptionModels();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: 'no-store' })
    );
  });
});
