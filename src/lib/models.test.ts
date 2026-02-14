import { describe, test, expect } from '@jest/globals';
import { getFirstFreeModel, isFreeModel, kiloFreeModels } from './models';

describe('isFreeModel', () => {
  describe('free models', () => {
    test('should return true for models ending with :free', () => {
      expect(isFreeModel('gpt-4:free')).toBe(true);
      expect(isFreeModel('claude-3:free')).toBe(true);
      expect(isFreeModel('some-model:free')).toBe(true);
      expect(isFreeModel(':free')).toBe(true);
    });

    test('should return true for openrouter/free', () => {
      expect(isFreeModel('openrouter/free')).toBe(true);
    });

    test('should return true for OpenRouter stealth models (alpha/beta)', () => {
      expect(isFreeModel('openrouter/model-alpha')).toBe(true);
      expect(isFreeModel('openrouter/model-beta')).toBe(true);
      expect(isFreeModel('openrouter/sonoma-dusk-alpha')).toBe(true);
      expect(isFreeModel('openrouter/sonoma-sky-beta')).toBe(true);
    });

    test('should return true for enabled Kilo free models', () => {
      // Test with known Kilo free models that are enabled
      const enabledModels = kiloFreeModels.filter(m => m.is_enabled);

      // Should have at least some enabled models
      expect(enabledModels.length).toBeGreaterThan(0);

      // All enabled models should be detected as free
      for (const model of enabledModels) {
        expect(isFreeModel(model.public_id)).toBe(true);
      }
    });

    test('should return false for disabled Kilo free models that do not end with :free', () => {
      const disabledModels = kiloFreeModels.filter(
        m => !m.is_enabled && !m.public_id.endsWith(':free')
      );

      // Disabled models without :free suffix should NOT be detected as free
      for (const model of disabledModels) {
        expect(isFreeModel(model.public_id)).toBe(false);
      }
    });

    test('should return true for disabled Kilo free models that end with :free', () => {
      const disabledModelsWithFreeSuffix = kiloFreeModels.filter(
        m => !m.is_enabled && m.public_id.endsWith(':free')
      );

      // Disabled models with :free suffix are still considered free due to the :free suffix rule
      // This is the current behavior - the :free suffix takes precedence over the enabled state
      for (const model of disabledModelsWithFreeSuffix) {
        expect(isFreeModel(model.public_id)).toBe(true);
      }
    });
  });

  describe('non-free models', () => {
    test('should return false for regular model names', () => {
      expect(isFreeModel('gpt-4')).toBe(false);
      expect(isFreeModel('claude-3.7-sonnet')).toBe(false);
      expect(isFreeModel('anthropic/claude-sonnet-4')).toBe(false);
      expect(isFreeModel('google/gemini-2.5-pro')).toBe(false);
    });

    test('should return false for models with "free" in the middle', () => {
      expect(isFreeModel('free-model')).toBe(false);
      expect(isFreeModel('model-free-version')).toBe(false);
      expect(isFreeModel('freemium')).toBe(false);
    });

    test('should return false for OpenRouter models that do not end with -alpha or -beta', () => {
      expect(isFreeModel('openrouter/model')).toBe(false);
      expect(isFreeModel('openrouter/model-gamma')).toBe(false);
      expect(isFreeModel('openrouter/model-stable')).toBe(false);
    });

    test('should return false for non-OpenRouter models ending with -alpha or -beta', () => {
      expect(isFreeModel('anthropic/model-alpha')).toBe(false);
      expect(isFreeModel('google/model-beta')).toBe(false);
      expect(isFreeModel('model-alpha')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('should return false for empty string', () => {
      expect(isFreeModel('')).toBe(false);
    });

    test('should return false for null/undefined', () => {
      expect(isFreeModel(null as unknown as string)).toBe(false);
      expect(isFreeModel(undefined as unknown as string)).toBe(false);
    });

    test('should be case-sensitive', () => {
      expect(isFreeModel('model:FREE')).toBe(false);
      expect(isFreeModel('model:Free')).toBe(false);
      expect(isFreeModel('OPENROUTER/FREE')).toBe(false);
      expect(isFreeModel('openrouter/model-ALPHA')).toBe(false);
    });

    test('should handle whitespace correctly', () => {
      expect(isFreeModel('model:free ')).toBe(false);
      expect(isFreeModel(' model:free')).toBe(true);
      expect(isFreeModel(' openrouter/free')).toBe(false);
      expect(isFreeModel('openrouter/free ')).toBe(false);
      expect(isFreeModel('openrouter/model-alpha ')).toBe(false);
    });
  });
});

describe('getFirstFreeModel', () => {
  test('should return a model that is actually free', () => {
    const firstFreeModel = getFirstFreeModel();
    expect(isFreeModel(firstFreeModel)).toBe(true);
  });
});
