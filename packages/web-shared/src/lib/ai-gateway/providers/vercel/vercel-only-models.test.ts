import { beforeEach, describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import { getVercelModelIdOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  findVercelOnlyModels,
  getVercelOnlyCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-only-models';
import {
  getVercelCatalog,
  parseVercelCatalog,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog';
import type * as VercelCatalogModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog';
import type * as GatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getVercelModelsMetadataFromDatabase: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog', () => ({
  ...jest.requireActual<typeof VercelCatalogModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog'
  ),
  getVercelCatalog: jest.fn(),
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

/** A Vercel `/v1/models` entry. */
function catalogEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: 'model',
    type: 'language',
    owned_by: id.slice(0, id.indexOf('/')),
    name: id.slice(id.indexOf('/') + 1),
    description: 'A Vercel model',
    created: 1_755_815_280,
    released: 1_790_000_000,
    context_window: 256_000,
    max_tokens: 32_000,
    modalities: { input: ['text', 'image'], output: ['text'] },
    supported_parameters: ['max_tokens', 'tools', 'reasoning'],
    pricing: { input: '0.0000004', output: '0.0000024', input_cache_read: '0.00000004' },
    ...overrides,
  };
}

function storedModel(
  id: string,
  {
    name = id.slice(id.indexOf('/') + 1),
    endpoints = [{ provider_name: id.slice(0, id.indexOf('/')) }],
  }: { name?: string; endpoints?: StoredModel['endpoints'] } = {}
): StoredModel {
  return { id, name, type: 'language', endpoints };
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

const vercelCatalog = parseVercelCatalog({
  data: [
    catalogEntry('alibaba/qwen3-max'),
    catalogEntry('alibaba/qwen3.5-flash', {
      released: 1_790_000_100,
      reasoning_options: [
        { type: 'budget_tokens', min: 1, max: 81_920 },
        { type: 'effort', values: ['instant', 'low', 'high'] },
      ],
    }),
    catalogEntry('openai/gpt-5-fast', {
      released: undefined,
      pricing: { input: '0.0000025', output: '0.00002', input_cache_write: '0.000003' },
      deprecated_at: Date.UTC(2027, 0, 15),
      reasoning_options: [{ type: 'unknown' }],
    }),
    catalogEntry('reflection/beam-free', {
      released: 1_780_000_000,
      pricing: { input: '0', output: '0' },
    }),
    catalogEntry('openai/gpt-5-codex'),
    catalogEntry('anthropic/claude-opus-5-fast'),
    catalogEntry('openai/text-embedding-3-small', { type: 'embedding' }),
    catalogEntry('quiverai/arrow-2-video', { modalities: { input: ['text'], output: ['video'] } }),
    catalogEntry('vendor/not-routable'),
    { id: 'broken/model' },
  ],
});

const vercelMetadata: Record<string, StoredModel> = Object.fromEntries(
  [
    storedModel('alibaba/qwen3-max'),
    storedModel('alibaba/qwen3.5-flash', {
      name: 'Qwen3.5 Flash',
      endpoints: [{ provider_name: 'alibaba' }, { provider_name: 'bedrock' }],
    }),
    storedModel('openai/gpt-5-fast', { name: 'GPT-5 (Fast)' }),
    storedModel('reflection/beam-free', { name: 'Beam (Free)' }),
    storedModel('openai/gpt-5-codex'),
    storedModel('anthropic/claude-opus-5-fast'),
    storedModel('openai/text-embedding-3-small'),
    storedModel('quiverai/arrow-2-video'),
    storedModel('broken/model'),
  ].map(model => [model.id, model])
);

const openRouterModels = [
  openRouterModel('qwen/qwen3-max', 'Qwen: Qwen3 Max'),
  openRouterModel('openai/gpt-5', 'OpenAI: GPT-5'),
];

function ids(models: { id: string }[]) {
  return models.map(model => model.id);
}

describe('parseVercelCatalog', () => {
  it('keeps text-output language models and skips entries that do not parse', () => {
    expect([...vercelCatalog.keys()]).toEqual([
      'alibaba/qwen3-max',
      'alibaba/qwen3.5-flash',
      'openai/gpt-5-fast',
      'reflection/beam-free',
      'openai/gpt-5-codex',
      'anthropic/claude-opus-5-fast',
      'vendor/not-routable',
    ]);
  });
});

describe('findVercelOnlyModels', () => {
  it('keeps routable Vercel chat models that no OpenRouter id maps to, under their reversed ids', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: ['qwen/qwen3-max', 'openai/gpt-5'],
      vercelMetadata,
      vercelCatalog,
      overrides: new Map(),
    });

    expect(ids(models)).toEqual([
      'qwen/qwen3.5-flash',
      'openai/gpt-5-fast',
      'reflection/beam-free',
      'openai/gpt-5-codex',
      'anthropic/claude-opus-5-fast',
    ]);
    expect(models[0]?.storedModel).toBe(vercelMetadata['alibaba/qwen3.5-flash']);
    expect(models[0]?.catalog).toBe(vercelCatalog.get('alibaba/qwen3.5-flash'));
  });

  it('treats a Vercel model an override points to as covered', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: ['openai/gpt-5-priority'],
      vercelMetadata,
      vercelCatalog,
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(ids(models)).not.toContain('openai/gpt-5-fast');
    expect(ids(models)).not.toContain('openai/gpt-5-priority');
  });

  it('lists a Vercel model under its override id when OpenRouter dropped that id', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: [],
      vercelMetadata,
      vercelCatalog,
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(ids(models)).toContain('openai/gpt-5-priority');
    expect(ids(models)).not.toContain('openai/gpt-5-fast');
  });

  it('skips ids with uppercase letters, which the proxy cannot route', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: [],
      vercelMetadata: { 'vendor/Model-X': storedModel('vendor/Model-X') },
      vercelCatalog: parseVercelCatalog({ data: [catalogEntry('vendor/Model-X')] }),
      overrides: new Map(),
    });

    expect(models).toEqual([]);
  });
});

describe('getVercelOnlyCatalogModels', () => {
  beforeEach(() => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue(vercelMetadata);
    jest.mocked(getVercelCatalog).mockResolvedValue(vercelCatalog);
    jest.mocked(getVercelModelIdOverrides).mockResolvedValue(new Map());
    jest.mocked(getRuntimeGatewayRoutingConfig).mockResolvedValue({
      vercelEnabled: true,
      vercelOptOutModels: new Set(['openai/gpt-5-codex']),
    });
  });

  it('builds catalog entries for routable Vercel-only chat models, newest first', async () => {
    const models = await getVercelOnlyCatalogModels({
      openRouterModels,
      openRouterMetadata: {},
    });

    expect(ids(models)).toEqual([
      'qwen/qwen3.5-flash',
      'reflection/beam-free',
      'openai/gpt-5-fast',
    ]);
    expect(models[0]).toEqual({
      id: 'qwen/qwen3.5-flash',
      name: 'Qwen: Qwen3.5 Flash',
      created: 1_790_000_100,
      description: 'A Vercel model',
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
      supported_parameters: ['max_tokens', 'tools', 'reasoning'],
      expiration_date: undefined,
      opencode: {
        ai_sdk_provider: undefined,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
        variants: {
          none: { reasoning: { enabled: false, effort: 'none' } },
          low: { reasoning: { enabled: true, effort: 'low' } },
          high: { reasoning: { enabled: true, effort: 'high' } },
        },
        prompt: undefined,
      },
    });
    expect(models[1]).toMatchObject({
      id: 'reflection/beam-free',
      name: 'Beam (Free)',
      pricing: { prompt: '0', completion: '0' },
    });
    expect(models[2]).toMatchObject({
      id: 'openai/gpt-5-fast',
      name: 'OpenAI: GPT-5 (Fast)',
      created: 1_755_815_280,
      pricing: { prompt: '0.0000025', completion: '0.00002', input_cache_write: '0.000003' },
      expiration_date: '2027-01-15',
      opencode: undefined,
    });
  });

  it('keeps a Claude model when a provider other than Anthropic serves it', async () => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'anthropic/claude-opus-5-fast': storedModel('anthropic/claude-opus-5-fast', {
        endpoints: [{ provider_name: 'anthropic' }, { provider_name: 'bedrock' }],
      }),
    });

    const models = await getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} });

    expect(ids(models)).toEqual(['anthropic/claude-opus-5-fast']);
  });

  it('skips the Vercel model list when every stored Vercel model has an OpenRouter id', async () => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'alibaba/qwen3-max': storedModel('alibaba/qwen3-max'),
    });
    jest.mocked(getVercelCatalog).mockClear();

    await expect(
      getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} })
    ).resolves.toEqual([]);
    expect(getVercelCatalog).not.toHaveBeenCalled();
  });

  it('lists nothing when the Vercel model list cannot be fetched', async () => {
    jest
      .mocked(getVercelCatalog)
      .mockRejectedValue(new Error('Fetching Vercel models failed: 503'));

    await expect(
      getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} })
    ).resolves.toEqual([]);
  });

  it('lists nothing when Vercel routing is disabled', async () => {
    jest.mocked(getRuntimeGatewayRoutingConfig).mockResolvedValue({
      vercelEnabled: false,
      vercelOptOutModels: new Set(),
    });

    await expect(
      getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} })
    ).resolves.toEqual([]);
  });

  it('treats models in the stored OpenRouter metadata as covered', async () => {
    const models = await getVercelOnlyCatalogModels({
      openRouterModels,
      openRouterMetadata: {
        'qwen/qwen3.5-flash': { id: 'qwen/qwen3.5-flash', name: 'Qwen3.5 Flash', endpoints: [] },
      },
    });

    expect(ids(models)).toEqual(['reflection/beam-free', 'openai/gpt-5-fast']);
  });
});
