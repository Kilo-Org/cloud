import { describe, expect, test } from '@jest/globals';
import { MARTIAN } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
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
  glyph_cluster_stealth_free_model,
  reflection_beam_free_model,
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

  test('serves stealth/glyph-cluster through Vercel AI Gateway as a free stealth model', () => {
    expect(findKiloExclusiveModel(glyph_cluster_stealth_free_model.public_id)).toMatchObject({
      public_id: 'stealth/glyph-cluster',
      internal_id: 'stealth/glyph-cluster',
      display_name: 'Stealth: Glyph Cluster (free)',
      context_length: 256_000,
      max_completion_tokens: 256_000,
      flags: ['reasoning', 'requires-data-collection'],
      pricing: null,
      inference_providers: ['stealth'],
    });
    expect(findKiloExclusiveModel('stealth/glyph-cluster')?.provider).toBe(VERCEL_AI_GATEWAY);
  });

  test('serves reflection/beam-free through Vercel AI Gateway as a free non-stealth model', () => {
    expect(findKiloExclusiveModel(reflection_beam_free_model.public_id)).toMatchObject({
      public_id: 'reflection/beam-free',
      internal_id: 'reflection/beam-free',
      display_name: 'Reflection: Beam 1.0 (free)',
      context_length: 1_048_576,
      max_completion_tokens: 131_072,
      flags: ['reasoning', 'requires-data-collection'],
      pricing: null,
      inference_providers: ['reflection'],
    });
    expect(findKiloExclusiveModel('reflection/beam-free')?.provider).toBe(VERCEL_AI_GATEWAY);
  });
});
