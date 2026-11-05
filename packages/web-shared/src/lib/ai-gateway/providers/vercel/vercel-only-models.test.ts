import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Endpoint, StoredModel } from '@kilocode/db/schema-types';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import { getVercelModelIdOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  findVercelOnlyModels,
  getVercelOnlyCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-only-models';
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

function endpoint(providerName: string, overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    provider_name: providerName,
    context_length: 256_000,
    max_completion_tokens: 32_000,
    supported_parameters: ['max_tokens', 'tools', 'reasoning'],
    pricing: { prompt: '0.0000004', completion: '0.0000024', input_cache_read: '0.00000004' },
    ...overrides,
  };
}

function storedModel(id: string, overrides: Partial<StoredModel> = {}): StoredModel {
  return {
    id,
    name: id.slice(id.indexOf('/') + 1),
    type: 'language',
    description: 'A Vercel model',
    created: 1_755_815_280,
    released: 1_790_000_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    endpoints: [endpoint(id.slice(0, id.indexOf('/')))],
    ...overrides,
  };
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

const vercelMetadata: Record<string, StoredModel> = Object.fromEntries(
  [
    storedModel('alibaba/qwen3-max'),
    storedModel('alibaba/qwen3.5-flash', {
      name: 'Qwen3.5 Flash',
      released: 1_790_000_100,
      reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
      endpoints: [
        endpoint('alibaba'),
        endpoint('bedrock', {
          context_length: 1_000_000,
          supported_parameters: ['max_tokens', 'temperature'],
        }),
      ],
    }),
    storedModel('openai/gpt-5-fast', {
      name: 'GPT-5 (Fast)',
      released: undefined,
      endpoints: [
        endpoint('openai', {
          pricing: { prompt: '0.0000025', completion: '0.00002', input_cache_write: '0.000003' },
        }),
      ],
    }),
    storedModel('reflection/beam-free', {
      name: 'Beam (Free)',
      released: 1_780_000_000,
      endpoints: [endpoint('reflection', { pricing: { prompt: '0', completion: '0' } })],
    }),
    storedModel('openai/gpt-5-codex'),
    storedModel('anthropic/claude-opus-5-fast'),
    storedModel('openai/text-embedding-3-small', { type: 'embedding' }),
    storedModel('quiverai/arrow-2-video', { architecture: { output_modalities: ['video'] } }),
    storedModel('meta/llama-4-scout', { architecture: undefined }),
    storedModel('vendor/unpriced', { endpoints: [endpoint('vendor', { pricing: undefined })] }),
  ].map(model => [model.id, model])
);

const openRouterModels = [
  openRouterModel('qwen/qwen3-max', 'Qwen: Qwen3 Max'),
  openRouterModel('openai/gpt-5', 'OpenAI: GPT-5'),
];

function ids(models: { id: string }[]) {
  return models.map(model => model.id);
}

describe('findVercelOnlyModels', () => {
  it('keeps Vercel chat models that no OpenRouter id maps to, under their reversed ids', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: ['qwen/qwen3-max', 'openai/gpt-5'],
      vercelMetadata,
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
  });

  it('treats a Vercel model an override points to as covered', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: ['openai/gpt-5-priority'],
      vercelMetadata,
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(ids(models)).not.toContain('openai/gpt-5-fast');
    expect(ids(models)).not.toContain('openai/gpt-5-priority');
  });

  it('lists a Vercel model under its override id when OpenRouter dropped that id', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: [],
      vercelMetadata,
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(ids(models)).toContain('openai/gpt-5-priority');
    expect(ids(models)).not.toContain('openai/gpt-5-fast');
  });

  it('skips ids with uppercase letters, which the proxy cannot route', () => {
    const models = findVercelOnlyModels({
      openRouterModelIds: [],
      vercelMetadata: { 'vendor/Model-X': storedModel('vendor/Model-X') },
      overrides: new Map(),
    });

    expect(models).toEqual([]);
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
        context_length: 1_000_000,
        max_completion_tokens: 32_000,
      },
      pricing: {
        prompt: '0.0000004',
        completion: '0.0000024',
        input_cache_read: '0.00000004',
      },
      context_length: 1_000_000,
      supported_parameters: ['max_tokens', 'tools', 'reasoning', 'temperature'],
      opencode: {
        ai_sdk_provider: undefined,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
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
      opencode: undefined,
    });
  });

  it('keeps a Claude model when a provider other than Anthropic serves it', async () => {
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'anthropic/claude-opus-5-fast': storedModel('anthropic/claude-opus-5-fast', {
        endpoints: [endpoint('anthropic'), endpoint('bedrock')],
      }),
    });

    const models = await getVercelOnlyCatalogModels({ openRouterModels, openRouterMetadata: {} });

    expect(ids(models)).toEqual(['anthropic/claude-opus-5-fast']);
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
