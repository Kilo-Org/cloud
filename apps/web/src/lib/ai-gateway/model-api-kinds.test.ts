import { describe, expect, it } from '@jest/globals';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from './model-api-kinds';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import {
  findKiloExclusiveModelServing,
  kiloExclusiveModelServing,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model-serving';
import type * as ServingModule from '@/lib/ai-gateway/providers/kilo-exclusive-model-serving';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/kilo-exclusive-models';

jest.mock('@/lib/ai-gateway/providers/kilo-exclusive-model-serving', () => {
  const actual = jest.requireActual<typeof ServingModule>(
    '@/lib/ai-gateway/providers/kilo-exclusive-model-serving'
  );
  return {
    ...actual,
    findKiloExclusiveModelServing: jest.fn(actual.findKiloExclusiveModelServing),
  };
});

describe('modelServesAllGatewayChatApis', () => {
  it('accepts a plain OpenRouter model (OpenRouter speaks all gateway chat APIs)', () => {
    expect(modelServesAllGatewayChatApis('openai/gpt-5-mini')).toBe(true);
  });

  it('rejects a Kilo-exclusive model served by a provider without Messages support', () => {
    jest.mocked(findKiloExclusiveModelServing).mockReturnValueOnce({
      model: gemma_4_26b_a4b_it_free_model,
      provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
    });
    expect(modelServesAllGatewayChatApis(gemma_4_26b_a4b_it_free_model.public_id)).toBe(false);
  });

  it.each(kiloExclusiveModelServing)(
    'uses the bound provider APIs for $model.public_id, falling back for disabled models',
    ({ model, provider }) => {
      expect(gatewayChatApisForModel(model.public_id)).toBe(
        model.status === 'disabled' ? OPENROUTER.supportedChatApis : provider.supportedChatApis
      );
    }
  );

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(modelServesAllGatewayChatApis('made-up/model')).toBe(true);
  });
});
