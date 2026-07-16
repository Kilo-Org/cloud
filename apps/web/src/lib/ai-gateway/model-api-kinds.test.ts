import { describe, expect, it } from '@jest/globals';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from './model-api-kinds';
import { seed_20_code_free_model } from '@/lib/ai-gateway/providers/seed';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type * as ModelsModule from '@/lib/ai-gateway/models';

// Stub the catalog so the rejection test doesn't depend on any specific provider file.
// 'test-exclusive/alibaba-only' resolves to a KiloExclusiveModel on the alibaba gateway,
// which only supports chat_completions, exercising the rejection branch.
jest.mock('@/lib/ai-gateway/models', () => {
  const actual = jest.requireActual<typeof ModelsModule>('@/lib/ai-gateway/models');
  const stubModel: KiloExclusiveModel = {
    public_id: 'test-exclusive/alibaba-only',
    display_name: 'Test Alibaba-only',
    description: 'stub for unit tests',
    context_length: 8192,
    max_completion_tokens: 4096,
    status: 'public',
    flags: [],
    gateway: 'alibaba',
    internal_id: 'stub-internal',
    pricing: null,
    inference_provider_restriction: [],
  };
  return {
    ...actual,
    findKiloExclusiveModel: (id: string) =>
      id === 'test-exclusive/alibaba-only' ? stubModel : actual.findKiloExclusiveModel(id),
  };
});

describe('modelServesAllGatewayChatApis', () => {
  it('accepts a plain OpenRouter model (OpenRouter speaks all gateway chat APIs)', () => {
    expect(modelServesAllGatewayChatApis('openai/gpt-5-mini')).toBe(true);
  });

  it('rejects a Kilo-exclusive model served by a chat-completions-only provider', () => {
    expect(modelServesAllGatewayChatApis('test-exclusive/alibaba-only')).toBe(false);
    expect(gatewayChatApisForModel('test-exclusive/alibaba-only')).toEqual(['chat_completions']);
  });

  it('treats disabled Kilo-exclusive models like plain OpenRouter models, matching get-provider', () => {
    expect(modelServesAllGatewayChatApis(seed_20_code_free_model.public_id)).toBe(true);
  });

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(modelServesAllGatewayChatApis('made-up/model')).toBe(true);
  });
});
