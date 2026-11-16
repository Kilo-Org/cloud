import { describe, expect, it } from '@jest/globals';
import type { ByokEndpointDefinition } from '@kilocode/db/schema-types';
import type { EnabledByokProvider } from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  convertByokEndpointModel,
  getByokEndpointCatalogModelIds,
  getByokEndpointModels,
} from './models';

const LIVE_CATALOG_IDS = new Set(['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5']);

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  isValidOpenRouterModelId: jest.fn(async (modelId: string) => LIVE_CATALOG_IDS.has(modelId)),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog', () => ({
  isCustomLlm: jest.fn(async (modelId: string) => modelId === 'openai/gpt-5.5'),
}));

function endpoint(name: string, modelIds: string[]): ByokEndpointDefinition {
  return {
    name,
    base_url: 'https://llm.acme.example/v1',
    api_kinds: ['messages', 'chat_completions'],
    client_provider: 'anthropic',
    reasoning_format: 'reasoning-details',
    models: modelIds.map(id => ({
      id,
      internal_id: `${id}-internal`,
      context_length: 200_000,
      max_completion_tokens: 32_000,
    })),
  };
}

describe('convertByokEndpointModel', () => {
  it('lists a model under its endpoint id, paid by the endpoint credentials', () => {
    const definition = endpoint('Acme', ['anthropic/claude-sonnet-4.6']);
    definition.models[0] = {
      ...definition.models[0],
      name: 'Sonnet',
      flags: ['vision', 'reasoning'],
    };

    const model = convertByokEndpointModel('endpoint-a1b2c3d4e5', definition, definition.models[0]);

    expect(model).toMatchObject({
      id: 'endpoint-a1b2c3d4e5/anthropic/claude-sonnet-4.6',
      name: 'Acme: Sonnet',
      context_length: 200_000,
      top_provider: { context_length: 200_000, max_completion_tokens: 32_000 },
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { request: '0', image: '0' },
      hasUserByokAvailable: true,
      isFree: false,
      opencode: { ai_sdk_provider: 'anthropic' },
    });
    expect(model.opencode?.reasoning_options?.length).toBeGreaterThan(0);
    expect(model.supported_parameters).toContain('reasoning');
  });

  it('names a model by its id and leaves Chat Completions clients without an AI SDK provider', () => {
    const definition = {
      ...endpoint('Acme', ['acme/unknown-model']),
      client_provider: 'openrouter' as const,
    };

    const model = convertByokEndpointModel('endpoint-a1b2c3d4e5', definition, definition.models[0]);

    expect(model.name).toBe('Acme: acme/unknown-model');
    expect(model.architecture.input_modalities).toEqual(['text']);
    expect(model.opencode?.ai_sdk_provider).toBeUndefined();
    expect(model.opencode?.reasoning_options).toBeUndefined();
  });

  it('offers reasoning options only for models flagged for reasoning', () => {
    const definition = endpoint('Acme', ['anthropic/claude-sonnet-4.6']);

    const unflagged = convertByokEndpointModel(
      'endpoint-a1b2c3d4e5',
      definition,
      definition.models[0]
    );

    expect(unflagged.supported_parameters).not.toContain('reasoning');
    expect(unflagged.opencode?.reasoning_options).toBeUndefined();
  });

  it('falls back to the upstream id for reasoning options', () => {
    const definition = endpoint('Acme', ['acme/coder']);
    const model = convertByokEndpointModel('endpoint-a1b2c3d4e5', definition, {
      ...definition.models[0],
      internal_id: 'claude-sonnet-4-6',
      flags: ['reasoning'],
    });

    expect(model.opencode?.reasoning_options?.length).toBeGreaterThan(0);
    expect(model.supported_parameters).toContain('reasoning');
  });
});

describe('endpoint model lists', () => {
  const keys: EnabledByokProvider[] = [
    {
      providerId: 'endpoint-aaaaaaaaaa',
      serveCatalogModels: false,
      endpoint: endpoint('Bespoke', ['acme/coder', 'anthropic/claude-sonnet-4.6']),
    },
    {
      providerId: 'endpoint-bbbbbbbbbb',
      serveCatalogModels: true,
      endpoint: endpoint('Catalog', [
        'anthropic/claude-sonnet-4.6',
        'openai/gpt-5.5',
        'acme/not-in-catalog',
      ]),
    },
    { providerId: 'openrouter', serveCatalogModels: false },
  ];

  it('lists bespoke ids only for endpoints outside catalog mode', () => {
    expect(getByokEndpointModels(keys).map(model => model.id)).toEqual([
      'endpoint-aaaaaaaaaa/acme/coder',
      'endpoint-aaaaaaaaaa/anthropic/claude-sonnet-4.6',
    ]);
  });

  it('serves the live catalog ids of catalog-mode endpoints that no custom LLM owns', async () => {
    expect([...(await getByokEndpointCatalogModelIds(keys))]).toEqual([
      'anthropic/claude-sonnet-4.6',
    ]);
  });
});
