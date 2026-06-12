import { describe, expect, it } from '@jest/globals';
import { supportedApiKindsForModel } from './model-api-kinds';
import { morph_warp_grep_free_model } from '@/lib/ai-gateway/providers/morph';
import { seed_20_code_free_model } from '@/lib/ai-gateway/providers/seed';

describe('supportedApiKindsForModel', () => {
  it('returns all OpenRouter chat APIs for a plain OpenRouter model', () => {
    expect(supportedApiKindsForModel('openai/gpt-5-mini')).toEqual([
      'chat_completions',
      'messages',
      'responses',
    ]);
  });

  it('uses the declared gateway for Kilo-exclusive models', () => {
    expect(supportedApiKindsForModel(morph_warp_grep_free_model.public_id)).toEqual([
      'chat_completions',
    ]);
  });

  it('treats disabled Kilo-exclusive models like plain OpenRouter models, matching get-provider', () => {
    expect(supportedApiKindsForModel(seed_20_code_free_model.public_id)).toEqual([
      'chat_completions',
      'messages',
      'responses',
    ]);
  });

  it('falls back to OpenRouter for unknown model ids', () => {
    expect(supportedApiKindsForModel('made-up/model')).toEqual([
      'chat_completions',
      'messages',
      'responses',
    ]);
  });
});
