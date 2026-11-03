import { describe, test, expect } from '@jest/globals';
import { selectAutoFreeCandidate } from './models';
import { hasBestEffortGuessDataCollectionRequirement, isFreeModel } from './is-free-model';
import { getRandomNumber } from './getRandomNumber';

describe('isFreeModel', () => {
  describe('free models', () => {
    test('should return true for models ending with :free', async () => {
      await expect(isFreeModel('gpt-4:free')).resolves.toBe(true);
      await expect(isFreeModel('claude-3:free')).resolves.toBe(true);
      await expect(isFreeModel('some-model:free')).resolves.toBe(true);
      await expect(isFreeModel(':free')).resolves.toBe(true);
    });

    test('should return true for openrouter/free', async () => {
      await expect(isFreeModel('openrouter/free')).resolves.toBe(true);
    });

    test('should return true for models ending with -free', async () => {
      await expect(isFreeModel('acme/model-free')).resolves.toBe(true);
      await expect(isFreeModel('model-free')).resolves.toBe(true);
    });

    test('should return true for stealth models', async () => {
      await expect(isFreeModel('stealth/ox-alpha')).resolves.toBe(true);
      await expect(isFreeModel('stealth/model-beta')).resolves.toBe(true);
      await expect(isFreeModel('stealth/glyph-cluster')).resolves.toBe(true);
      await expect(isFreeModel('openrouter/model-alpha')).resolves.toBe(false);
    });

    test.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])(
      'treats %s as free',
      async model => {
        await expect(isFreeModel(model)).resolves.toBe(true);
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
      await expect(isFreeModel('gpt-4')).resolves.toBe(false);
      await expect(isFreeModel('claude-3.7-sonnet')).resolves.toBe(false);
      await expect(isFreeModel('anthropic/claude-sonnet-4')).resolves.toBe(false);
      await expect(isFreeModel('google/gemini-2.5-pro')).resolves.toBe(false);
    });

    test('should return false for models with "free" in the middle', async () => {
      await expect(isFreeModel('free-model')).resolves.toBe(false);
      await expect(isFreeModel('model-free-version')).resolves.toBe(false);
      await expect(isFreeModel('freemium')).resolves.toBe(false);
    });

    test('should return false for OpenRouter models including alpha/beta', async () => {
      await expect(isFreeModel('openrouter/model')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/model-gamma')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/model-stable')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/model-alpha')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/model-beta')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/sonoma-dusk-alpha')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/sonoma-sky-beta')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/auto-beta')).resolves.toBe(false);
    });

    test('should return false for non-OpenRouter models ending with -alpha or -beta', async () => {
      await expect(isFreeModel('anthropic/model-alpha')).resolves.toBe(false);
      await expect(isFreeModel('google/model-beta')).resolves.toBe(false);
      await expect(isFreeModel('model-alpha')).resolves.toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should return false for empty string', async () => {
      await expect(isFreeModel('')).resolves.toBe(false);
    });

    test('should return false for null/undefined', async () => {
      await expect(isFreeModel(null as unknown as string)).resolves.toBe(false);
      await expect(isFreeModel(undefined as unknown as string)).resolves.toBe(false);
    });

    test('should be case-sensitive', async () => {
      await expect(isFreeModel('model:FREE')).resolves.toBe(false);
      await expect(isFreeModel('model:Free')).resolves.toBe(false);
      await expect(isFreeModel('OPENROUTER/FREE')).resolves.toBe(false);
      await expect(isFreeModel('model-FREE')).resolves.toBe(false);
      await expect(isFreeModel('Stealth/model')).resolves.toBe(false);
    });

    test('should handle whitespace correctly', async () => {
      await expect(isFreeModel('model:free ')).resolves.toBe(false);
      await expect(isFreeModel(' model:free')).resolves.toBe(true);
      await expect(isFreeModel(' openrouter/free')).resolves.toBe(false);
      await expect(isFreeModel('openrouter/free ')).resolves.toBe(false);
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
