import { describe, test, expect } from '@jest/globals';
import { selectAutoFreeCandidate } from './models';
import {
  findKiloExclusiveModel,
  getKiloExclusiveInferenceProviders,
  kiloExclusiveModels,
  shouldRedactErrorResponse,
  shouldRedactModelNameInMicrodollarUsage,
} from './kilo-exclusive-models';
import {
  hasBestEffortGuessDataCollectionRequirement,
  isFreeModelExcludingCustomLlms,
} from './is-free-model';
import { getInferenceProviders } from './providers/kilo-exclusive-model';
import { gemma_4_26b_a4b_it_free_model } from './kilo-exclusive-models';
import { getRandomNumber } from './getRandomNumber';
import {
  kiloExclusiveModelFixture,
  useKiloExclusiveModel,
} from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';

useKiloExclusiveModel();

describe('isFreeModelExcludingCustomLlms', () => {
  test('returns a boolean synchronously', () => {
    expect(isFreeModelExcludingCustomLlms('openrouter/free')).toBe(true);
    expect(isFreeModelExcludingCustomLlms('anthropic/claude-sonnet-4')).toBe(false);
  });

  describe('free models', () => {
    test('should return true for models ending with :free', async () => {
      expect(isFreeModelExcludingCustomLlms('gpt-4:free')).toBe(true);
      expect(isFreeModelExcludingCustomLlms('claude-3:free')).toBe(true);
      expect(isFreeModelExcludingCustomLlms('some-model:free')).toBe(true);
      expect(isFreeModelExcludingCustomLlms(':free')).toBe(true);
    });

    test('should return true for openrouter/free', async () => {
      expect(isFreeModelExcludingCustomLlms('openrouter/free')).toBe(true);
    });

    test('should return true for OpenRouter stealth alpha models', async () => {
      expect(isFreeModelExcludingCustomLlms('stealth/ox-alpha')).toBe(true);
      expect(isFreeModelExcludingCustomLlms('stealth/other-alpha')).toBe(true);
      expect(isFreeModelExcludingCustomLlms('stealth/paid-model')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/model-alpha')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('stealth/model-beta')).toBe(false);
    });

    test('should return true for Kilo exclusive models', async () => {
      expect(kiloExclusiveModels).toContain(kiloExclusiveModelFixture);
      for (const model of kiloExclusiveModels) {
        expect(isFreeModelExcludingCustomLlms(model.public_id)).toBe(true);
      }
    });

    test('getInferenceProviders does not crash for any Kilo exclusive model', () => {
      expect(kiloExclusiveModels.length).toBeGreaterThan(0);
      for (const model of kiloExclusiveModels) {
        expect(() => getInferenceProviders(model)).not.toThrow();
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
      'stealth/glyph-cluster',
      'reflection/beam-free',
    ])('removes %s from exclusive models', modelId => {
      expect(kiloExclusiveModels.some(model => model.public_id === modelId)).toBe(false);
      expect(findKiloExclusiveModel(modelId)).toBeNull();
    });

    test.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])(
      'inherits %s without an exclusive definition or provider restriction',
      async model => {
        expect(kiloExclusiveModels.some(entry => entry.public_id === model)).toBe(false);
        expect(findKiloExclusiveModel(model)).toBeNull();
        expect(getKiloExclusiveInferenceProviders(model)).toBeUndefined();
        expect(isFreeModelExcludingCustomLlms(model)).toBe(true);
      }
    );

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
      expect(isFreeModelExcludingCustomLlms('gpt-4')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('claude-3.7-sonnet')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('anthropic/claude-sonnet-4')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('google/gemini-2.5-pro')).toBe(false);
    });

    test('should return false for models with "free" in the middle', async () => {
      expect(isFreeModelExcludingCustomLlms('free-model')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('model-free-version')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('freemium')).toBe(false);
    });

    test('should return false for OpenRouter models including alpha/beta', async () => {
      expect(isFreeModelExcludingCustomLlms('openrouter/model')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/model-gamma')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/model-stable')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/model-alpha')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/model-beta')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/sonoma-dusk-alpha')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/sonoma-sky-beta')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/auto-beta')).toBe(false);
    });

    test('should return false for non-OpenRouter models ending with -alpha or -beta', async () => {
      expect(isFreeModelExcludingCustomLlms('anthropic/model-alpha')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('google/model-beta')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('model-alpha')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should return false for empty string', async () => {
      expect(isFreeModelExcludingCustomLlms('')).toBe(false);
    });

    test('should return false for null/undefined', async () => {
      expect(isFreeModelExcludingCustomLlms(null as unknown as string)).toBe(false);
      expect(isFreeModelExcludingCustomLlms(undefined as unknown as string)).toBe(false);
    });

    test('should be case-sensitive', async () => {
      expect(isFreeModelExcludingCustomLlms('model:FREE')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('model:Free')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('OPENROUTER/FREE')).toBe(false);
    });

    test('should handle whitespace correctly', async () => {
      expect(isFreeModelExcludingCustomLlms('model:free ')).toBe(false);
      expect(isFreeModelExcludingCustomLlms(' model:free')).toBe(true);
      expect(isFreeModelExcludingCustomLlms(' openrouter/free')).toBe(false);
      expect(isFreeModelExcludingCustomLlms('openrouter/free ')).toBe(false);
    });
  });
});

describe('hasBestEffortGuessDataCollectionRequirement', () => {
  test('requires data collection for Kilo-exclusive models', async () => {
    expect(
      await hasBestEffortGuessDataCollectionRequirement(kiloExclusiveModelFixture.public_id)
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
    expect(shouldRedactErrorResponse('openrouter', kiloExclusiveModelFixture.public_id)).toBe(true);
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
      shouldRedactModelNameInMicrodollarUsage('openrouter', kiloExclusiveModelFixture.public_id)
    ).toBe(true);
  });
});

describe('getKiloExclusiveInferenceProviders', () => {
  test('returns the stealth provider for stealth exclusives', () => {
    expect([
      ...(getKiloExclusiveInferenceProviders(kiloExclusiveModelFixture.public_id) ?? []),
    ]).toEqual(['stealth']);
  });

  test('does not treat removed or unrestricted exclusives or unknown ids as restricted', () => {
    expect(getKiloExclusiveInferenceProviders('stepfun/step-5-preview-free')).toBeUndefined();
    expect(getKiloExclusiveInferenceProviders('openai/gpt-5.6-sol-discounted')).toBeUndefined();
    expect(getKiloExclusiveInferenceProviders('tencent/hy3:free')).toBeUndefined();
    expect(
      getKiloExclusiveInferenceProviders(gemma_4_26b_a4b_it_free_model.public_id)
    ).toBeUndefined();
    expect(getKiloExclusiveInferenceProviders('deepseek/deepseek-v4-pro')).toBeUndefined();
    expect(getKiloExclusiveInferenceProviders('unknown/model')).toBeUndefined();
  });
});
