import { describe, test, expect } from '@jest/globals';
import { buildPreferredModels, selectAutoFreeCandidate } from './models';
import {
  findKiloExclusiveModel,
  getKiloExclusiveInferenceProviderRestriction,
  isKiloExclusiveRateLimitedModel,
  kiloExclusiveModels,
  shouldRedactErrorResponse,
  shouldRedactModelNameInMicrodollarUsage,
} from './kilo-exclusive-models';
import { hasBestEffortGuessDataCollectionRequirement, isFreeModel } from './is-free-model';
import { getInferenceProvider } from './providers/kilo-exclusive-model';
import {
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
} from './kilo-exclusive-models';
import {
  gemma_4_26b_a4b_it_free_model,
  glyph_cluster_stealth_free_model,
} from './kilo-exclusive-models';
import { isUnavailableModel } from './unavailable-models';
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

describe('Glyph Cluster stealth model', () => {
  test('is free, stealth, and requires data collection', () => {
    expect(isFreeModel('stealth/glyph-cluster')).toBe(true);
    expect(hasBestEffortGuessDataCollectionRequirement('stealth/glyph-cluster')).toBe(true);
    expect(shouldRedactModelNameInMicrodollarUsage('vercel', 'stealth/glyph-cluster')).toBe(true);
    expect(shouldRedactErrorResponse('vercel', 'stealth/glyph-cluster')).toBe(true);
    expect(getInferenceProvider(glyph_cluster_stealth_free_model)).toEqual({
      slug: 'stealth',
      name: 'Stealth',
      training: true,
      retainsPrompts: true,
    });
  });
});

describe('isFreeModel', () => {
  test('returns a boolean synchronously', () => {
    expect(isFreeModel('openrouter/free')).toBe(true);
    expect(isFreeModel('anthropic/claude-sonnet-4')).toBe(false);
  });

  describe('free models', () => {
    test('should return true for models ending with :free', async () => {
      expect(await isFreeModel('gpt-4:free')).toBe(true);
      expect(await isFreeModel('claude-3:free')).toBe(true);
      expect(await isFreeModel('some-model:free')).toBe(true);
      expect(await isFreeModel(':free')).toBe(true);
    });

    test('should return true for openrouter/free', async () => {
      expect(await isFreeModel('openrouter/free')).toBe(true);
    });

    test('recognizes inclusionai/ling-3.1-flash as free without the suffix', () => {
      expect(isFreeModel('inclusionai/ling-3.1-flash')).toBe(true);
    });

    test.each([
      'inclusionai/ling-3.0-flash',
      'inclusionai/ling-3.1-flash-preview',
      'INCLUSIONAI/LING-3.1-FLASH',
      ' inclusionai/ling-3.1-flash',
      'inclusionai/ling-3.1-flash ',
    ])('does not classify %s as free', model => {
      expect(isFreeModel(model)).toBe(false);
    });

    test('should return true for OpenRouter stealth alpha models', async () => {
      expect(await isFreeModel('stealth/ox-alpha')).toBe(true);
      expect(await isFreeModel('stealth/other-alpha')).toBe(true);
      expect(await isFreeModel('stealth/claude-opus-4.7')).toBe(false);
      expect(await isFreeModel('stealth/qwen3.6-plus')).toBe(false);
      expect(await isFreeModel('openrouter/model-alpha')).toBe(false);
      expect(await isFreeModel('stealth/model-beta')).toBe(false);
    });

    test('should return true for enabled Kilo exclusive models with no pricing', async () => {
      // Test with known Kilo exclusive models that are enabled and have no pricing (free)
      const enabledFreeModels = kiloExclusiveModels.filter(
        m => m.status === 'public' && !m.pricing
      );

      // All enabled free models should be detected as free
      for (const model of enabledFreeModels) {
        expect(await isFreeModel(model.public_id)).toBe(true);
      }
    });

    test('should return false for enabled Kilo exclusive models with pricing', async () => {
      // Models with pricing should NOT be free
      const pricedModels = kiloExclusiveModels.filter(m => m.status !== 'disabled' && !!m.pricing);

      for (const model of pricedModels) {
        expect(await isFreeModel(model.public_id)).toBe(false);
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
          expect(isFreeModel(modelId)).toBe(false);
        } finally {
          kiloExclusiveModels.splice(kiloExclusiveModels.indexOf(pricedModel), 1);
        }
      }
    );

    test('ignores pricing on disabled Kilo exclusive models', () => {
      const disabledModel = {
        ...claude_opus_4_7_stealth_model,
        public_id: 'vendor/disabled-priced-exclusive:free',
        status: 'disabled' as const,
      };
      kiloExclusiveModels.push(disabledModel);
      try {
        expect(isFreeModel(disabledModel.public_id)).toBe(true);
      } finally {
        kiloExclusiveModels.splice(kiloExclusiveModels.indexOf(disabledModel), 1);
      }
    });

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

    test.each(['tencent/hy3:free', 'meituan/longcat-2.0-free', 'nex-agi/nex-n2.5-pro:free'])(
      'removes %s from exclusive and preferred models without restricting availability',
      modelId => {
        expect(kiloExclusiveModels.some(model => model.public_id === modelId)).toBe(false);
        expect(findKiloExclusiveModel(modelId)).toBeNull();
        expect(isUnavailableModel(modelId)).toBe(false);
        expect(buildPreferredModels([])).not.toContain(modelId);
      }
    );

    test.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])(
      'inherits %s without an exclusive definition or availability restriction',
      async model => {
        expect(kiloExclusiveModels.some(entry => entry.public_id === model)).toBe(false);
        expect(findKiloExclusiveModel(model)).toBeNull();
        expect(getKiloExclusiveInferenceProviderRestriction(model)).toBeUndefined();
        expect(isUnavailableModel(model)).toBe(false);
        expect(await isFreeModel(model)).toBe(true);
      }
    );

    test('keeps MiniMax free models outside preferred models', () => {
      for (const model of ['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free']) {
        expect(buildPreferredModels([])).not.toContain(model);
      }
    });

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
      expect(await isFreeModel('gpt-4')).toBe(false);
      expect(await isFreeModel('claude-3.7-sonnet')).toBe(false);
      expect(await isFreeModel('anthropic/claude-sonnet-4')).toBe(false);
      expect(await isFreeModel('google/gemini-2.5-pro')).toBe(false);
    });

    test('should return false for models with "free" in the middle', async () => {
      expect(await isFreeModel('free-model')).toBe(false);
      expect(await isFreeModel('model-free-version')).toBe(false);
      expect(await isFreeModel('freemium')).toBe(false);
    });

    test('should return false for OpenRouter models including alpha/beta', async () => {
      expect(await isFreeModel('openrouter/model')).toBe(false);
      expect(await isFreeModel('openrouter/model-gamma')).toBe(false);
      expect(await isFreeModel('openrouter/model-stable')).toBe(false);
      expect(await isFreeModel('openrouter/model-alpha')).toBe(false);
      expect(await isFreeModel('openrouter/model-beta')).toBe(false);
      expect(await isFreeModel('openrouter/sonoma-dusk-alpha')).toBe(false);
      expect(await isFreeModel('openrouter/sonoma-sky-beta')).toBe(false);
      expect(await isFreeModel('openrouter/auto-beta')).toBe(false);
    });

    test('should return false for non-OpenRouter models ending with -alpha or -beta', async () => {
      expect(await isFreeModel('anthropic/model-alpha')).toBe(false);
      expect(await isFreeModel('google/model-beta')).toBe(false);
      expect(await isFreeModel('model-alpha')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should return false for empty string', async () => {
      expect(await isFreeModel('')).toBe(false);
    });

    test('should return false for null/undefined', async () => {
      expect(await isFreeModel(null as unknown as string)).toBe(false);
      expect(await isFreeModel(undefined as unknown as string)).toBe(false);
    });

    test('should be case-sensitive', async () => {
      expect(await isFreeModel('model:FREE')).toBe(false);
      expect(await isFreeModel('model:Free')).toBe(false);
      expect(await isFreeModel('OPENROUTER/FREE')).toBe(false);
    });

    test('should handle whitespace correctly', async () => {
      expect(await isFreeModel('model:free ')).toBe(false);
      expect(await isFreeModel(' model:free')).toBe(true);
      expect(await isFreeModel(' openrouter/free')).toBe(false);
      expect(await isFreeModel('openrouter/free ')).toBe(false);
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
    expect(await hasBestEffortGuessDataCollectionRequirement('inclusionai/ling-3.1-flash')).toBe(
      true
    );
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
  test('returns the routing allow-list for restricted exclusive models', () => {
    expect(getKiloExclusiveInferenceProviderRestriction('stepfun/step-3.7-flash:free')).toEqual(
      new Set(['stepfun'])
    );
  });

  test('does not treat removed or unrestricted exclusives or unknown ids as restricted', () => {
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
