import { describe, expect, it } from '@jest/globals';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from './model-api-kinds';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import {
  findKiloExclusiveModel,
  kiloExclusiveModels,
  gemma_4_26b_a4b_it_free_model,
} from '@/lib/ai-gateway/kilo-exclusive-models';
import type * as ExclusiveModelsModule from '@/lib/ai-gateway/kilo-exclusive-models';

jest.mock('@/lib/ai-gateway/kilo-exclusive-models', () => {
  const actual = jest.requireActual<typeof ExclusiveModelsModule>(
    '@/lib/ai-gateway/kilo-exclusive-models'
  );
  return {
    ...actual,
    findKiloExclusiveModel: jest.fn(actual.findKiloExclusiveModel),
  };
});

describe('modelServesAllGatewayChatApis', () => {
  it('accepts a plain OpenRouter model (OpenRouter speaks all gateway chat APIs)', () => {
    expect(modelServesAllGatewayChatApis('openai/gpt-5-mini')).toBe(true);
  });

  it('rejects a Kilo-exclusive model served by a provider without Messages support', () => {
    jest.mocked(findKiloExclusiveModel).mockReturnValueOnce({
      ...gemma_4_26b_a4b_it_free_model,
      provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
    });
    expect(modelServesAllGatewayChatApis(gemma_4_26b_a4b_it_free_model.public_id)).toBe(false);
  });

  it.each(kiloExclusiveModels)(
    'uses the provider APIs for $public_id, falling back for disabled models',
    model => {
      expect(gatewayChatApisForModel(model.public_id)).toBe(
        model.status === 'disabled'
          ? OPENROUTER.supportedChatApis
          : model.provider.supportedChatApis
      );
    }
  );

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(modelServesAllGatewayChatApis('made-up/model')).toBe(true);
  });
});
