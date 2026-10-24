import { describe, expect, it } from '@jest/globals';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from './model-api-kinds';
import type { KiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import type * as ModelsModule from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type * as OpenRouterModule from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';

// Stub the catalog so the rejection test doesn't depend on any specific provider file.
// 'test-exclusive/chat-only' resolves to a synthetic provider that does not support Messages.
jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => {
  const actual = jest.requireActual<typeof ModelsModule>(
    '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models'
  );
  const { OPENROUTER } = jest.requireActual<typeof OpenRouterModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter'
  );
  const stubModels: KiloExclusiveModel[] = [
    {
      public_id: 'test-exclusive/chat-only',
      display_name: 'Test chat-only model',
      description: 'stub for unit tests',
      context_length: 8192,
      max_completion_tokens: 4096,
      flags: [],
      provider: { ...OPENROUTER, id: 'dev-tools', supportedChatApis: ['chat_completions'] },
      internal_id: 'stub-internal',
      pricing: null,
      inference_providers: [],
    },
  ];
  return {
    ...actual,
    findKiloExclusiveModel: (id: string) =>
      stubModels.find(m => m.public_id === id) ?? actual.findKiloExclusiveModel(id),
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

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(modelServesAllGatewayChatApis('made-up/model')).toBe(true);
  });
});
