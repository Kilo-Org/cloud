import { describe, expect, test } from '@jest/globals';
import { MARTIAN } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import {
  findKiloExclusiveModel,
  isKiloStealthModel,
  kiloExclusiveModels,
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  qwen36_plus_stealth_model,
  gemma_4_26b_a4b_it_free_model,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';

describe('Kilo-exclusive model providers', () => {
  test.each(kiloExclusiveModels)(
    '$public_id only omits inference providers when routed through OpenRouter or Vercel',
    model => {
      if (model.inference_providers.length === 0) {
        expect(['openrouter', 'vercel']).toContain(model.provider.id);
      }
    }
  );

  test.each([
    claude_opus_4_8_stealth_model,
    claude_opus_4_7_stealth_model,
    claude_sonnet_4_6_stealth_model,
    claude_opus_4_6_stealth_model,
    qwen36_plus_stealth_model,
  ])('serves $public_id through Martian as a stealth model', model => {
    expect(findKiloExclusiveModel(model.public_id)?.provider).toBe(MARTIAN);
    expect(model.inference_providers).toEqual(['stealth']);
    expect(isKiloStealthModel(model.public_id)).toBe(true);
  });

  test.each([gemma_4_26b_a4b_it_free_model])('serves $public_id through OpenRouter', model => {
    expect(findKiloExclusiveModel(model.public_id)?.provider).toBe(OPENROUTER);
  });
});
