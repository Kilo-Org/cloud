import { describe, test, expect } from '@jest/globals';
import {
  autoFreeModels,
  findKiloExclusiveModel,
  getKiloExclusiveInferenceProviderRestriction,
  isKiloExclusiveRateLimitedModel,
  kiloExclusiveModels,
  preferredModels,
  selectAutoFreeCandidate,
  shouldRedactErrorResponse,
  shouldRedactModelNameInMicrodollarUsage,
} from './models';
import { hasBestEffortGuessDataCollectionRequirement, isFreeModel } from './is-free-model';
import { getInferenceProvider } from './providers/kilo-exclusive-model';
import { getAiSdkProvider } from './providers/model-settings';
import {
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
} from './providers/anthropic.constants';
import { deepseek_v4_pro_discounted_model } from './providers/deepseek';
import { gpt_5_6_sol_stealth_model } from './providers/openai-exclusive';
import { tencent_hy3_free_model } from './providers/tencent';
import { gemma_4_26b_a4b_it_free_model } from './providers/google';
import { longcat_2_free_model } from './providers/longcat';
import { getRandomNumber } from './getRandomNumber';

describe('rate-limited Kilo-exclusive models', () => {
  test('only includes free Gemma', () => {
    expect(kiloExclusiveModels.filter(model => model.flags.includes('rate-limited'))).toEqual([
      gemma_4_26b_a4b_it_free_model,
    ]);
    expect(isKiloExclusiveRateLimitedModel(gemma_4_26b_a4b_it_free_model.public_id)).toBe(true);
    expect(isKiloExclusiveRateLimitedModel(tencent_hy3_free_model.public_id)).toBe(false);
  });
});

describe('isFreeModel', () => {
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

    test('registers Tencent Hy3 as an Auto Free model', () => {
      expect(findKiloExclusiveModel('tencent/hy3:free')).toBe(tencent_hy3_free_model);
      expect(tencent_hy3_free_model.internal_id).toBe('tencent/hy3');
      expect(tencent_hy3_free_model.inference_provider_restriction).toEqual(['tencent']);
      expect(autoFreeModels.map(({ model }) => model)).toContain(tencent_hy3_free_model.public_id);
    });

    test('retains the disabled LongCat 2.0 configuration for later enablement', async () => {
      expect(kiloExclusiveModels).toContain(longcat_2_free_model);
      expect(findKiloExclusiveModel(longcat_2_free_model.public_id)).toBeNull();
      expect(await isFreeModel(longcat_2_free_model.public_id)).toBe(false);
      expect(longcat_2_free_model).toMatchObject({
        internal_id: 'LongCat-2.0',
        gateway: 'longcat',
        context_length: 1_048_756,
        max_completion_tokens: 131_072,
        status: 'disabled',
      });
      expect(autoFreeModels.map(({ model }) => model)).not.toContain(
        longcat_2_free_model.public_id
      );
      expect(preferredModels).not.toContain(longcat_2_free_model.public_id);
      expect(getAiSdkProvider(longcat_2_free_model.public_id, null)).toBe('openai-compatible');
    });

    test('routes the discounted Claude Opus offering through the stealth provider identity', () => {
      expect(getInferenceProvider(claude_opus_4_7_stealth_model)?.slug).toBe('stealth');
      expect(claude_opus_4_7_stealth_model.public_id).toBe('stealth/claude-opus-4.7');
      expect(getInferenceProvider(claude_sonnet_4_6_stealth_model)?.slug).toBe('stealth');
      expect(claude_sonnet_4_6_stealth_model.public_id).toBe('stealth/claude-sonnet-4.6');
      expect(getInferenceProvider(claude_opus_4_6_stealth_model)?.slug).toBe('stealth');
      expect(claude_opus_4_6_stealth_model.public_id).toBe('stealth/claude-opus-4.6');
    });

    test('registers GPT-5.6 Sol as a Martian stealth model', () => {
      expect(findKiloExclusiveModel('stealth/gpt-5.6-sol')).toBe(gpt_5_6_sol_stealth_model);
      expect(gpt_5_6_sol_stealth_model.internal_id).toBe('openai/gpt-5.6-sol:optimized');
      expect(gpt_5_6_sol_stealth_model.gateway).toBe('martian');
      expect(getInferenceProvider(gpt_5_6_sol_stealth_model)?.slug).toBe('stealth');
      expect(gpt_5_6_sol_stealth_model.pricing?.tiers).toEqual([
        {
          start_context_length: 0,
          pricing: {
            prompt_per_million: 4,
            completion_per_million: 24,
            input_cache_read_per_million: 0.4,
            input_cache_write_per_million: 5,
          },
        },
        {
          start_context_length: 272_000,
          pricing: {
            prompt_per_million: 8,
            completion_per_million: 36,
            input_cache_read_per_million: 0.8,
            input_cache_write_per_million: 10,
          },
        },
      ]);
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

    test('should return false for disabled Kilo exclusive models that do not end with :free', async () => {
      const disabledModels = kiloExclusiveModels.filter(
        m => m.status === 'disabled' && !m.public_id.endsWith(':free')
      );

      // Disabled models without :free suffix should NOT be detected as free
      for (const model of disabledModels) {
        expect(await isFreeModel(model.public_id)).toBe(false);
      }
    });

    test('all autoFreeModels should pass isFreeModel', async () => {
      expect(autoFreeModels.length).toBeGreaterThan(0);
      for (const { model } of autoFreeModels) {
        expect(await isFreeModel(model)).toBe(true);
      }
    });

    test('all autoFreeModels should have positive integer weights', () => {
      for (const { weight } of autoFreeModels) {
        expect(Number.isInteger(weight)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
    });

    test('hardcodes the most aggressive reasoning for every Auto Free model', () => {
      expect(
        Object.fromEntries(autoFreeModels.map(({ model, reasoning }) => [model, reasoning]))
      ).toEqual({
        'stepfun/step-3.7-flash:free': { enabled: true, effort: 'high' },
        'tencent/hy3:free': { enabled: true, effort: 'high' },
        'poolside/laguna-s-2.1:free': { enabled: true, effort: 'high' },
      });
    });

    test('weights Auto Free models at 80% StepFun, 10% Hy3, and 10% Laguna', () => {
      expect(
        Object.fromEntries(autoFreeModels.map(({ model, weight }) => [model, weight]))
      ).toEqual({
        'stepfun/step-3.7-flash:free': 8,
        'tencent/hy3:free': 1,
        'poolside/laguna-s-2.1:free': 1,
      });
    });

    test('uses autoFreeModels weights when selecting a model', () => {
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

    test('all autoFreeModels should use the same AI SDK provider', () => {
      expect(autoFreeModels.length).toBeGreaterThan(0);
      const providers = new Set(autoFreeModels.map(({ model }) => getAiSdkProvider(model, null)));
      expect(providers.size).toBe(1);
    });

    test('should return true for disabled Kilo exclusive models that end with :free', async () => {
      const disabledModelsWithFreeSuffix = kiloExclusiveModels.filter(
        m => m.status === 'disabled' && m.public_id.endsWith(':free')
      );

      // Disabled models with :free suffix are still considered free due to the :free suffix rule
      // This is the current behavior - the :free suffix takes precedence over the enabled state
      for (const model of disabledModelsWithFreeSuffix) {
        expect(await isFreeModel(model.public_id)).toBe(true);
      }
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

  test('redacts errors for experiment provider', () => {
    expect(shouldRedactErrorResponse('experiment', 'some-experiment-model')).toBe(true);
  });

  test('redacts errors for stealth models regardless of provider', () => {
    expect(shouldRedactErrorResponse('openrouter', claude_opus_4_7_stealth_model.public_id)).toBe(
      true
    );
    expect(shouldRedactErrorResponse('martian', gpt_5_6_sol_stealth_model.public_id)).toBe(true);
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

  test('redacts model name for experiment provider', () => {
    expect(shouldRedactModelNameInMicrodollarUsage('experiment', 'some-experiment-model')).toBe(
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
    expect(
      getKiloExclusiveInferenceProviderRestriction(deepseek_v4_pro_discounted_model.public_id)
    ).toEqual(new Set(['deepseek']));
    expect(getKiloExclusiveInferenceProviderRestriction(tencent_hy3_free_model.public_id)).toEqual(
      new Set(['tencent'])
    );
  });

  test('does not treat unrestricted exclusives or unknown ids as restricted', () => {
    expect(
      getKiloExclusiveInferenceProviderRestriction(gpt_5_6_sol_stealth_model.public_id)
    ).toBeUndefined();
    expect(
      getKiloExclusiveInferenceProviderRestriction(gemma_4_26b_a4b_it_free_model.public_id)
    ).toBeUndefined();
    expect(
      getKiloExclusiveInferenceProviderRestriction('deepseek/deepseek-v4-pro')
    ).toBeUndefined();
    expect(getKiloExclusiveInferenceProviderRestriction('unknown/model')).toBeUndefined();
  });
});
