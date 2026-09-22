import { describe, expect, it } from '@jest/globals';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from './model-api-kinds';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import type * as ModelsModule from '@/lib/ai-gateway/models';

jest.mock('@/lib/ai-gateway/providers/definitions/try-get-provider-by-id', () => {
  const actual = jest.requireActual<
    typeof import('@/lib/ai-gateway/providers/definitions/try-get-provider-by-id')
  >('@/lib/ai-gateway/providers/definitions/try-get-provider-by-id');
  return {
    ...actual,
    tryGetProviderById: (providerId: ProviderId) =>
      providerId === 'dev-tools'
        ? { supportedChatApis: ['chat_completions'] }
        : actual.tryGetProviderById(providerId),
  };
});

// Stub the catalog so the rejection test doesn't depend on any specific provider file.
// 'test-exclusive/chat-only' resolves to a synthetic provider that does not support Messages.
// 'test-exclusive/disabled' is filtered out by findKiloExclusiveModel, mirroring how
// disabled catalog models fall back to OpenRouter.
jest.mock('@/lib/ai-gateway/models', () => {
  const actual = jest.requireActual<typeof ModelsModule>('@/lib/ai-gateway/models');
  const stubModels: KiloExclusiveModel[] = [
    {
      public_id: 'test-exclusive/chat-only',
      display_name: 'Test chat-only model',
      description: 'stub for unit tests',
      context_length: 8192,
      max_completion_tokens: 4096,
      status: 'public',
      flags: [],
      gateway: 'dev-tools',
      internal_id: 'stub-internal',
      pricing: null,
      inference_provider_restriction: [],
    },
    {
      public_id: 'test-exclusive/disabled',
      display_name: 'Test Disabled',
      description: 'stub for unit tests',
      context_length: 8192,
      max_completion_tokens: 4096,
      status: 'disabled',
      flags: [],
      gateway: 'dev-tools',
      internal_id: 'stub-internal-disabled',
      pricing: null,
      inference_provider_restriction: [],
    },
  ];
  return {
    ...actual,
    findKiloExclusiveModel: (id: string) =>
      stubModels.find(m => m.public_id === id && m.status !== 'disabled') ??
      actual.findKiloExclusiveModel(id),
  };
});

describe('modelServesAllGatewayChatApis', () => {
  it('accepts a plain OpenRouter model (OpenRouter speaks all gateway chat APIs)', () => {
    expect(modelServesAllGatewayChatApis('openai/gpt-5-mini')).toBe(true);
  });

  it('rejects a Kilo-exclusive model served by a provider without Messages support', () => {
    expect(modelServesAllGatewayChatApis('test-exclusive/chat-only')).toBe(false);
    expect(gatewayChatApisForModel('test-exclusive/chat-only')).toEqual(['chat_completions']);
  });

  it('treats disabled Kilo-exclusive models like plain OpenRouter models, matching get-provider', () => {
    expect(modelServesAllGatewayChatApis('test-exclusive/disabled')).toBe(true);
  });

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(modelServesAllGatewayChatApis('made-up/model')).toBe(true);
  });
});
