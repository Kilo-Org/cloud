import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import { getVercelModelIdOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  findVercelOnlyModelIds,
  getVercelOnlyCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-only-models';
import { createMockResponse } from '@kilocode/web-shared/tests/helpers/openrouter-models.helper';
import {
  kiloExclusiveModelFixture,
  useKiloExclusiveModel,
} from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';
import type * as GatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getVercelModelsMetadataFromDatabase: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/routing-config', () => ({
  getRuntimeGatewayRoutingConfig: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  ...jest.requireActual<typeof MapModelIdToVercelModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
  ),
  getVercelModelIdOverrides: jest.fn(),
}));

useKiloExclusiveModel();

const originalFetch = global.fetch;

function storedModel(
  id: string,
  type: StoredModel['type'],
  endpoints: StoredModel['endpoints'] = [{ provider_name: id.slice(0, id.indexOf('/')) }]
): StoredModel {
  return { id, name: id, type, endpoints };
}

function openRouterModel(id: string, name: string): OpenRouterModel {
  return {
    id,
    name,
    created: 1_700_000_000,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    context_length: 128_000,
  };
}

function vercelCatalogEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: 'model',
    created: 1_755_815_280,
    released: 1_790_000_000,
    owned_by: id.slice(0, id.indexOf('/')),
    name: id.slice(id.indexOf('/') + 1),
    description: `${id} description`,
    context_window: 256_000,
    max_tokens: 32_000,
    type: 'language',
    modalities: { input: ['text', 'image'], output: ['text'] },
    supported_parameters: ['max_tokens', 'tools', 'reasoning'],
    pricing: { input: '0.0000004', output: '0.0000024', input_cache_read: '0.00000004' },
    ...overrides,
  };
}

const vercelMetadata: Record<string, StoredModel> = {
  'alibaba/qwen3-max': storedModel('alibaba/qwen3-max', 'language'),
  'alibaba/qwen3.5-flash': storedModel('alibaba/qwen3.5-flash', 'language', [
    { provider_name: 'alibaba', has_no_training: true },
    { provider_name: 'bedrock' },
    { provider_name: 'vertexAnthropic' },
  ]),
  'openai/gpt-5-fast': storedModel('openai/gpt-5-fast', 'language'),
  'openai/gpt-5-codex': storedModel('openai/gpt-5-codex', 'language'),
  'openai/text-embedding-3-small': storedModel('openai/text-embedding-3-small', 'embedding'),
  'meta/llama-4-scout': storedModel('meta/llama-4-scout', 'language'),
  'quiverai/arrow-2-video': storedModel('quiverai/arrow-2-video', 'language'),
  'anthropic/claude-opus-5-fast': storedModel('anthropic/claude-opus-5-fast', 'language'),
  'reflection/beam-free': storedModel('reflection/beam-free', 'language'),
};

const vercelCatalog = [
  vercelCatalogEntry('alibaba/qwen3-max'),
  vercelCatalogEntry('alibaba/qwen3.5-flash', {
    name: 'Qwen3.5 Flash',
    released: 1_790_000_100,
    supported_parameters: undefined,
  }),
  vercelCatalogEntry('openai/gpt-5-fast', {
    name: 'GPT-5 (Fast)',
    released: undefined,
    pricing: { input: '0.0000025', output: '0.00002', input_cache_write: '0.000003' },
    deprecated_at: Date.UTC(2027, 0, 15),
  }),
  vercelCatalogEntry('openai/gpt-5-codex'),
  vercelCatalogEntry('openai/text-embedding-3-small', { type: 'embedding' }),
  vercelCatalogEntry('quiverai/arrow-2-video', {
    modalities: { input: ['text'], output: ['video'] },
  }),
  vercelCatalogEntry('anthropic/claude-opus-5-fast'),
  vercelCatalogEntry('reflection/beam-free', { pricing: { input: '0', output: '0' } }),
  { id: 'broken/model' },
];

const openRouterModels = [
  openRouterModel('qwen/qwen3-max', 'Qwen: Qwen3 Max'),
  openRouterModel('openai/gpt-5', 'OpenAI: GPT-5'),
];

describe('findVercelOnlyModelIds', () => {
  it('keeps Vercel language models that no OpenRouter id maps to, under their reversed ids', () => {
    expect(
      findVercelOnlyModelIds({
        openRouterModelIds: ['qwen/qwen3-max', 'openai/gpt-5'],
        vercelMetadata,
        overrides: new Map(),
      })
    ).toEqual(
      new Map([
        ['qwen/qwen3.5-flash', 'alibaba/qwen3.5-flash'],
        ['openai/gpt-5-fast', 'openai/gpt-5-fast'],
        ['openai/gpt-5-codex', 'openai/gpt-5-codex'],
        ['meta/llama-4-scout', 'meta/llama-4-scout'],
        ['quiverai/arrow-2-video', 'quiverai/arrow-2-video'],
        ['anthropic/claude-opus-5-fast', 'anthropic/claude-opus-5-fast'],
        ['reflection/beam-free', 'reflection/beam-free'],
      ])
    );
  });

  it('treats a Vercel model an override points to as covered', () => {
    const ids = findVercelOnlyModelIds({
      openRouterModelIds: ['openai/gpt-5-priority'],
      vercelMetadata,
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(ids.has('openai/gpt-5-fast')).toBe(false);
    expect(ids.has('openai/gpt-5-priority')).toBe(false);
  });

  it('lists a Vercel model under its override id when OpenRouter dropped that id', () => {
    const ids = findVercelOnlyModelIds({
      openRouterModelIds: [],
      vercelMetadata,
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(ids.get('openai/gpt-5-priority')).toBe('openai/gpt-5-fast');
  });

  it('treats the internal id of a Kilo-exclusive model as covered', () => {
    const ids = findVercelOnlyModelIds({
      openRouterModelIds: [],
      vercelMetadata: {
        [kiloExclusiveModelFixture.internal_id]: storedModel(
          kiloExclusiveModelFixture.internal_id,
          'language'
        ),
      },
      overrides: new Map(),
    });

    expect(ids.size).toBe(0);
  });

  it('skips ids with uppercase letters, which the proxy cannot route', () => {
    const ids = findVercelOnlyModelIds({
      openRouterModelIds: [],
      vercelMetadata: { 'vendor/Model-X': storedModel('vendor/Model-X', 'language') },
      overrides: new Map(),
    });

    expect(ids.size).toBe(0);
  });
});

describe('getVercelOnlyCatalogModels', () => {
  beforeEach(() => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue(vercelMetadata);
    jest.mocked(getVercelModelIdOverrides).mockResolvedValue(new Map());
    jest.mocked(getRuntimeGatewayRoutingConfig).mockResolvedValue({
      vercelEnabled: true,
      vercelOptOutModels: new Set(['openai/gpt-5-codex']),
    });
    // The module caches the catalog: the tests that expect no fetch run first, and every test
    // serves the same response.
    global.fetch = jest.fn(() =>
      Promise.resolve(createMockResponse({ jsonData: { data: vercelCatalog } }))
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('lists nothing and skips the Vercel catalog when Vercel routing is disabled', async () => {
    jest.mocked(getRuntimeGatewayRoutingConfig).mockResolvedValue({
      vercelEnabled: false,
      vercelOptOutModels: new Set(),
    });

    await expect(
      getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} })
    ).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips the Vercel catalog when every Vercel model has an OpenRouter equivalent', async () => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'alibaba/qwen3-max': vercelMetadata['alibaba/qwen3-max'],
    });

    await expect(
      getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} })
    ).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('builds catalog entries for routable, paid Vercel-only chat models, newest first', async () => {
    const models = await getVercelOnlyCatalogModels({
      openRouterModels,
      openRouterMetadata: {},
    });

    expect(models).toEqual([
      {
        model: {
          id: 'qwen/qwen3.5-flash',
          name: 'Qwen: Qwen3.5 Flash',
          created: 1_790_000_100,
          description: 'alibaba/qwen3.5-flash description',
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            tokenizer: 'Other',
          },
          top_provider: {
            is_moderated: false,
            context_length: 256_000,
            max_completion_tokens: 32_000,
          },
          pricing: {
            prompt: '0.0000004',
            completion: '0.0000024',
            input_cache_read: '0.00000004',
          },
          context_length: 256_000,
          supported_parameters: undefined,
          expiration_date: undefined,
          mayTrainOnYourPrompts: false,
        },
        inferenceProviderIds: ['alibaba', 'amazon-bedrock', 'google-vertex'],
      },
      {
        model: expect.objectContaining({
          id: 'openai/gpt-5-fast',
          name: 'OpenAI: GPT-5 (Fast)',
          created: 1_755_815_280,
          pricing: { prompt: '0.0000025', completion: '0.00002', input_cache_write: '0.000003' },
          supported_parameters: ['max_tokens', 'tools', 'reasoning'],
          expiration_date: '2027-01-15',
          mayTrainOnYourPrompts: true,
        }),
        inferenceProviderIds: ['openai'],
      },
    ]);
  });

  it('keeps a Claude model when a provider other than Anthropic serves it', async () => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'anthropic/claude-opus-5-fast': storedModel('anthropic/claude-opus-5-fast', 'language', [
        { provider_name: 'anthropic' },
        { provider_name: 'bedrock' },
      ]),
    });

    const models = await getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} });

    expect(models.map(({ model }) => model.id)).toEqual(['anthropic/claude-opus-5-fast']);
  });

  it('treats models in the stored OpenRouter metadata as covered', async () => {
    const models = await getVercelOnlyCatalogModels({
      openRouterModels,
      openRouterMetadata: {
        'qwen/qwen3.5-flash': storedModel('qwen/qwen3.5-flash', undefined),
      },
    });

    expect(models.map(({ model }) => model.id)).toEqual(['openai/gpt-5-fast']);
  });
});
