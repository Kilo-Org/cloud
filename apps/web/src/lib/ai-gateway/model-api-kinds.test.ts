import { describe, expect, it } from '@jest/globals';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from './model-api-kinds';
import { morph_warp_grep_free_model } from '@/lib/ai-gateway/providers/morph';
import { seed_20_code_free_model } from '@/lib/ai-gateway/providers/seed';

describe('modelServesAllGatewayChatApis', () => {
  it('accepts a plain OpenRouter model (OpenRouter speaks all gateway chat APIs)', () => {
    expect(modelServesAllGatewayChatApis('openai/gpt-5-mini')).toBe(true);
  });

  it('rejects a Kilo-exclusive model served by a chat-completions-only provider', () => {
    expect(modelServesAllGatewayChatApis(morph_warp_grep_free_model.public_id)).toBe(false);
    expect(gatewayChatApisForModel(morph_warp_grep_free_model.public_id)).toEqual([
      'chat_completions',
    ]);
  });

  it('treats disabled Kilo-exclusive models like plain OpenRouter models, matching get-provider', () => {
    expect(modelServesAllGatewayChatApis(seed_20_code_free_model.public_id)).toBe(true);
  });

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(modelServesAllGatewayChatApis('made-up/model')).toBe(true);
  });
});
