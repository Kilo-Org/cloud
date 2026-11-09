import { describe, test, expect } from '@jest/globals';
import { selectAutoFreeCandidate } from './models';
import { hasBestEffortGuessDataCollectionRequirement, isFreeModel } from './is-free-model';
import { getRandomNumber } from './getRandomNumber';

describe('isFreeModel', () => {
  describe('free models', () => {
    test('should return true for models ending with :free', async () => {
      expect(isFreeModel('gpt-4:free')).toBe(true);
      expect(isFreeModel('claude-3:free')).toBe(true);
      expect(isFreeModel('some-model:free')).toBe(true);
      expect(isFreeModel(':free')).toBe(true);
    });

    test('should return true for openrouter/free', async () => {
      expect(isFreeModel('openrouter/free')).toBe(true);
    });

    test('should return true for models ending with -free', async () => {
      expect(isFreeModel('acme/model-free')).toBe(true);
      expect(isFreeModel('model-free')).toBe(true);
    });

    test('should return true for stealth models', async () => {
      expect(isFreeModel('stealth/ox-alpha')).toBe(true);
      expect(isFreeModel('stealth/model-beta')).toBe(true);
      expect(isFreeModel('stealth/glyph-cluster')).toBe(true);
      expect(isFreeModel('openrouter/model-alpha')).toBe(false);
    });

    test.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])(
      'treats %s as free',
      async model => {
        expect(isFreeModel(model)).toBe(true);
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
      expect(isFreeModel('gpt-4')).toBe(false);
      expect(isFreeModel('claude-3.7-sonnet')).toBe(false);
      expect(isFreeModel('anthropic/claude-sonnet-4')).toBe(false);
      expect(isFreeModel('google/gemini-2.5-pro')).toBe(false);
    });

    test('should return false for models with "free" in the middle', async () => {
      expect(isFreeModel('free-model')).toBe(false);
      expect(isFreeModel('model-free-version')).toBe(false);
      expect(isFreeModel('freemium')).toBe(false);
    });

    test('should return false for OpenRouter models including alpha/beta', async () => {
      expect(isFreeModel('openrouter/model')).toBe(false);
      expect(isFreeModel('openrouter/model-gamma')).toBe(false);
      expect(isFreeModel('openrouter/model-stable')).toBe(false);
      expect(isFreeModel('openrouter/model-alpha')).toBe(false);
      expect(isFreeModel('openrouter/model-beta')).toBe(false);
      expect(isFreeModel('openrouter/sonoma-dusk-alpha')).toBe(false);
      expect(isFreeModel('openrouter/sonoma-sky-beta')).toBe(false);
      expect(isFreeModel('openrouter/auto-beta')).toBe(false);
    });

    test('should return false for non-OpenRouter models ending with -alpha or -beta', async () => {
      expect(isFreeModel('anthropic/model-alpha')).toBe(false);
      expect(isFreeModel('google/model-beta')).toBe(false);
      expect(isFreeModel('model-alpha')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should return false for empty string', async () => {
      expect(isFreeModel('')).toBe(false);
    });

    test('should return false for null/undefined', async () => {
      expect(isFreeModel(null as unknown as string)).toBe(false);
      expect(isFreeModel(undefined as unknown as string)).toBe(false);
    });

    test('should be case-sensitive', async () => {
      expect(isFreeModel('model:FREE')).toBe(false);
      expect(isFreeModel('model:Free')).toBe(false);
      expect(isFreeModel('OPENROUTER/FREE')).toBe(false);
      expect(isFreeModel('model-FREE')).toBe(false);
      expect(isFreeModel('Stealth/model')).toBe(false);
    });

    test('should handle whitespace correctly', async () => {
      expect(isFreeModel('model:free ')).toBe(false);
      expect(isFreeModel(' model:free')).toBe(true);
      expect(isFreeModel(' openrouter/free')).toBe(false);
      expect(isFreeModel('openrouter/free ')).toBe(false);
    });
  });
});

describe('hasBestEffortGuessDataCollectionRequirement', () => {
  test('requires data collection for free models', async () => {
    expect(await hasBestEffortGuessDataCollectionRequirement('openrouter/free')).toBe(true);
  });

  test('does not require data collection for regular paid models', async () => {
    expect(await hasBestEffortGuessDataCollectionRequirement('anthropic/claude-sonnet-4')).toBe(
      false
    );
  });
});
