import { describe, test, expect } from '@jest/globals';
import { selectAutoFreeCandidate } from './models';
import {
  findKiloExclusiveModel,
  getKiloExclusiveInferenceProviderRestriction,
  isKiloExclusiveRateLimitedModel,
  kiloExclusiveModels,
  shouldRedactErrorResponse,
  shouldRedactModelNameInMicrodollarUsage,
} from './kilo-exclusive-models';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModelExcludingCustomLlms,
} from './is-free-model';
import { getInferenceProvider } from './providers/kilo-exclusive-model';
import {
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
} from './kilo-exclusive-models';
import {
  gemma_4_26b_a4b_it_free_model,
  glyph_cluster_stealth_free_model,
  reflection_beam_free_model,
} from './kilo-exclusive-models';
import { getRandomNumber } from './getRandomNumber';

describe('rate-limited Kilo-exclusive models', () => {
  test('only includes free Gemma', () => {
    expect(kiloExclusiveModels.filter(model => model.flags.includes('rate-limited'))).toEqual([
      gemma_4_26b_a4b_it_free_model,
    ]);
    expect(isKiloExclusiveRateLimitedModel(gemma_4_26b_a4b_it_free_model.public_id)).toBe(true);
    expect(isKiloExclusiveRateLimitedModel('tencent/hy3:free')).toBe(false);
  });
});

describe('Glyph Cluster', () => {
  test('is free, stealth, and requires data collection', () => {
    const model = glyph_cluster_stealth_free_model;
    expect(isFreeModelExcludingCustomLlms(model.public_id)).toBe(true);
    expect(hasBestEffortGuessDataCollectionRequirement(model.public_id)).toBe(true);
    expect(shouldRedactModelNameInMicrodollarUsage('vercel', model.public_id)).toBe(true);
    expect(shouldRedactErrorResponse('vercel', model.public_id)).toBe(true);
    expect(getInferenceProvider(model)).toEqual({
      slug: 'stealth',
      name: 'Stealth',
      training: true,
      retainsPrompts: true,
    });
  });
});

describe('Reflection Beam (free)', () => {
  test('is free, not stealth, requires data collection, and routes only to Reflection', () => {
    const model = reflection_beam_free_model;
    expect(isFreeModelExcludingCustomLlms(model.public_id)).toBe(true);
    expect(hasBestEffortGuessDataCollectionRequirement(model.public_id)).toBe(true);
    expect(shouldRedactModelNameInMicrodollarUsage('vercel', model.public_id)).toBe(false);
    expect(shouldRedactErrorResponse('vercel', model.public_id)).toBe(false);
    expect(getInferenceProvider(model)).toEqual({
      slug: 'reflection',
      name: 'REFLECTION',
      training: true,
      retainsPrompts: true,
    });
    expect([...(getKiloExclusiveInferenceProviderRestriction(model.public_id) ?? [])]).toEqual([
      'reflection',
    ]);
  });
});

describe('isFreeModelExcludingCustomLlms', () => {
  test('returns a boolean synchronously', () => {
    expect(isFreeModelExcludingCustomLlms('openrouter/free')).toBe(true);
    expect(isFreeModelExcludingCustomLlms('anthropic/claude-sonnet-4')).toBe(false);
  });

  describe('free models', () => {
    test('should return true for models ending with :free', async () => {
      expect(await isFreeModelExcludingCustomLlms('gpt-4:free')).toBe(true);
      expect(await isFreeModelExcludingCustomLlms('claude-3:free')).toBe(true);
      expect(await isFreeModelExcludingCustomLlms('some-model:free')).toBe(true);
      expect(await isFreeModelExcludingCustomLlms(':free')).toBe(true);
    });

    test('should return true for openrouter/free', async () => {
      expect(await isFreeModelExcludingCustomLlms('openrouter/free')).toBe(true);
    });

    test('should return true for OpenRouter stealth alpha models', async () => {
      expect(await isFreeModelExcludingCustomLlms('stealth/ox-alpha')).toBe(true);
      expect(await isFreeModelExcludingCustomLlms('stealth/other-alpha')).toBe(true);
      expect(await isFreeModelExcludingCustomLlms('stealth/claude-opus-4.7')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('stealth/qwen3.6-plus')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/model-alpha')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('stealth/model-beta')).toBe(false);
    });

    test('should return true for Kilo exclusive models with no pricing', async () => {
      for (const model of kiloExclusiveModels.filter(m => !m.pricing)) {
        expect(await isFreeModelExcludingCustomLlms(model.public_id)).toBe(true);
      }
    });

    test('should return false for Kilo exclusive models with pricing', async () => {
      for (const model of kiloExclusiveModels.filter(m => !!m.pricing)) {
        expect(await isFreeModelExcludingCustomLlms(model.public_id)).toBe(false);
      }
    });

    test.each(['vendor/priced-exclusive:free', 'stealth/priced-exclusive-alpha'])(
      'returns false for priced Kilo exclusive model %s even when its id matches a free pattern',
      modelId => {
        const pricedModel = {
          ...claude_opus_4_7_stealth_model,
          public_id: modelId,
        };
        kiloExclusiveModels.push(pricedModel);
        try {
          expect(isFreeModelExcludingCustomLlms(modelId)).toBe(false);
        } finally {
          kiloExclusiveModels.splice(kiloExclusiveModels.indexOf(pricedModel), 1);
        }
      }
    );

    test('getInferenceProvider does not crash for any Kilo exclusive model', () => {
      expect(kiloExclusiveModels.length).toBeGreaterThan(0);
      for (const model of kiloExclusiveModels) {
        expect(() => getInferenceProvider(model)).not.toThrow();
      }
    });

    test('does not register discounted OpenRouter Qwen models as Kilo exclusive', () => {
      expect(findKiloExclusiveModel('qwen/qwen3.7-max')).toBeNull();
      expect(findKiloExclusiveModel('qwen/qwen3.7-plus')).toBeNull();
    });

    test.each([
      'tencent/hy3:free',
      'meituan/longcat-2.0-free',
      'nex-agi/nex-n2.5-pro:free',
      'stepfun/step-5-preview-free',
      'stealth/cat-jam',
    ])('removes %s from exclusive models', modelId => {
      expect(kiloExclusiveModels.some(model => model.public_id === modelId)).toBe(false);
      expect(findKiloExclusiveModel(modelId)).toBeNull();
    });

    test.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])(
      'inherits %s without an exclusive definition or provider restriction',
      async model => {
        expect(kiloExclusiveModels.some(entry => entry.public_id === model)).toBe(false);
        expect(findKiloExclusiveModel(model)).toBeNull();
        expect(getKiloExclusiveInferenceProviderRestriction(model)).toBeUndefined();
        expect(await isFreeModelExcludingCustomLlms(model)).toBe(true);
      }
    );

    test('routes the discounted Claude Opus offering through the stealth provider identity', () => {
      expect(getInferenceProvider(claude_opus_4_7_stealth_model)?.slug).toBe('stealth');
      expect(claude_opus_4_7_stealth_model.public_id).toBe('stealth/claude-opus-4.7');
      expect(getInferenceProvider(claude_sonnet_4_6_stealth_model)?.slug).toBe('stealth');
      expect(claude_sonnet_4_6_stealth_model.public_id).toBe('stealth/claude-sonnet-4.6');
      expect(getInferenceProvider(claude_opus_4_6_stealth_model)?.slug).toBe('stealth');
      expect(claude_opus_4_6_stealth_model.public_id).toBe('stealth/claude-opus-4.6');
    });

    test('all Kilo exclusive models should have either no pricing or valid ordered pricing tiers', () => {
      for (const model of kiloExclusiveModels) {
        if (model.pricing) {
          expect(model.pricing.tiers[0].start_context_length).toBe(0);
          let previousStartContextLength = -1;
          for (const tier of model.pricing.tiers) {
            expect(typeof tier.pricing.prompt_per_million).toBe('number');
            expect(typeof tier.pricing.completion_per_million).toBe('number');
            expect(tier.start_context_length).toBeGreaterThan(previousStartContextLength);
            previousStartContextLength = tier.start_context_length;
          }
        }
      }
    });

    test('uses candidate weights when selecting an Auto Free model', () => {
      const candidates = [
        { model: 'preferred/model', weight: 3, reasoning: { enabled: true } },
        { model: 'other/model', weight: 1, reasoning: { enabled: true } },
      ];
      const randomSeed = Array.from({ length: 100 }, (_, index) => `weight-test-${index}`).find(
        seed => getRandomNumber(seed, 4) === 1
      );
      expect(randomSeed).toBeDefined();
      if (!randomSeed) return;

      expect(getRandomNumber(randomSeed, 4)).toBe(1);
      expect(selectAutoFreeCandidate(candidates, randomSeed)).toBe(candidates[0]);
    });
  });

  describe('non-free models', () => {
    test('should return false for regular model names', async () => {
      expect(await isFreeModelExcludingCustomLlms('gpt-4')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('claude-3.7-sonnet')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('anthropic/claude-sonnet-4')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('google/gemini-2.5-pro')).toBe(false);
    });

    test('should return false for models with "free" in the middle', async () => {
      expect(await isFreeModelExcludingCustomLlms('free-model')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('model-free-version')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('freemium')).toBe(false);
    });

    test('should return false for OpenRouter models including alpha/beta', async () => {
      expect(await isFreeModelExcludingCustomLlms('openrouter/model')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/model-gamma')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/model-stable')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/model-alpha')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/model-beta')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/sonoma-dusk-alpha')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/sonoma-sky-beta')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/auto-beta')).toBe(false);
    });

    test('should return false for non-OpenRouter models ending with -alpha or -beta', async () => {
      expect(await isFreeModelExcludingCustomLlms('anthropic/model-alpha')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('google/model-beta')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('model-alpha')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should return false for empty string', async () => {
      expect(await isFreeModelExcludingCustomLlms('')).toBe(false);
    });

    test('should return false for null/undefined', async () => {
      expect(await isFreeModelExcludingCustomLlms(null as unknown as string)).toBe(false);
      expect(await isFreeModelExcludingCustomLlms(undefined as unknown as string)).toBe(false);
    });

    test('should be case-sensitive', async () => {
      expect(await isFreeModelExcludingCustomLlms('model:FREE')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('model:Free')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('OPENROUTER/FREE')).toBe(false);
    });

    test('should handle whitespace correctly', async () => {
      expect(await isFreeModelExcludingCustomLlms('model:free ')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms(' model:free')).toBe(true);
      expect(await isFreeModelExcludingCustomLlms(' openrouter/free')).toBe(false);
      expect(await isFreeModelExcludingCustomLlms('openrouter/free ')).toBe(false);
    });
  });
});

describe('hasBestEffortGuessDataCollectionRequirement', () => {
  test('requires data collection for paid training-enabled offerings', async () => {
    expect(
      await hasBestEffortGuessDataCollectionRequirement(claude_opus_4_7_stealth_model.public_id)
    ).toBe(true);
    expect(
      await hasBestEffortGuessDataCollectionRequirement(claude_sonnet_4_6_stealth_model.public_id)
    ).toBe(true);
    expect(
      await hasBestEffortGuessDataCollectionRequirement(claude_opus_4_6_stealth_model.public_id)
    ).toBe(true);
  });

  test('requires data collection for free models', async () => {
    expect(await hasBestEffortGuessDataCollectionRequirement('openrouter/free')).toBe(true);
  });

  test('does not require data collection for regular paid models', async () => {
    expect(await hasBestEffortGuessDataCollectionRequirement('anthropic/claude-sonnet-4')).toBe(
      false
    );
  });
});

describe('shouldRedactErrorResponse', () => {
  test('does not redact errors for custom models', () => {
    expect(shouldRedactErrorResponse('custom', 'kilo-internal/my-custom-model')).toBe(false);
  });

  test('redacts errors for stealth models regardless of provider', () => {
    expect(shouldRedactErrorResponse('openrouter', claude_opus_4_7_stealth_model.public_id)).toBe(
      true
    );
  });

  test('does not redact errors for regular models and providers', () => {
    expect(shouldRedactErrorResponse('openrouter', 'anthropic/claude-3.5-sonnet')).toBe(false);
    expect(shouldRedactErrorResponse('vercel', 'openai/gpt-4o')).toBe(false);
  });
});

describe('shouldRedactModelNameInMicrodollarUsage', () => {
  test('redacts model name for custom provider', () => {
    expect(shouldRedactModelNameInMicrodollarUsage('custom', 'kilo-internal/my-custom-model')).toBe(
      true
    );
  });

  test('redacts model name for stealth models', () => {
    expect(
      shouldRedactModelNameInMicrodollarUsage('openrouter', claude_opus_4_7_stealth_model.public_id)
    ).toBe(true);
  });
});

describe('getKiloExclusiveInferenceProviderRestriction', () => {
  test('does not treat removed or unrestricted exclusives or unknown ids as restricted', () => {
    expect(
      getKiloExclusiveInferenceProviderRestriction('stepfun/step-5-preview-free')
    ).toBeUndefined();
    expect(
      getKiloExclusiveInferenceProviderRestriction('openai/gpt-5.6-sol-discounted')
    ).toBeUndefined();
    expect(getKiloExclusiveInferenceProviderRestriction('tencent/hy3:free')).toBeUndefined();
    expect(
      getKiloExclusiveInferenceProviderRestriction(gemma_4_26b_a4b_it_free_model.public_id)
    ).toBeUndefined();
    expect(
      getKiloExclusiveInferenceProviderRestriction('deepseek/deepseek-v4-pro')
    ).toBeUndefined();
    expect(getKiloExclusiveInferenceProviderRestriction('unknown/model')).toBeUndefined();
  });
});
