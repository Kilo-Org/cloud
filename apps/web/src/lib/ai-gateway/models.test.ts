import { describe, test, expect } from '@jest/globals';
import { autoFreeModels, isFreeModel, kiloExclusiveModels } from './models';

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

    test('should return true for enabled Kilo exclusive models with no pricing', () => {
      // Test with known Kilo exclusive models that are enabled and have no pricing (free)
      const enabledFreeModels = kiloExclusiveModels.filter(
        m => m.status === 'public' && !m.pricing
      );

      // Should have at least some enabled free models
      expect(enabledFreeModels.length).toBeGreaterThan(0);

      // All enabled free models should be detected as free
      for (const model of enabledFreeModels) {
        expect(isFreeModel(model.public_id)).toBe(true);
      }
    });

    test('should return false for enabled Kilo exclusive models with pricing', () => {
      // Models with pricing should NOT be free
      const pricedModels = kiloExclusiveModels.filter(m => m.status !== 'disabled' && !!m.pricing);

      for (const model of pricedModels) {
        expect(isFreeModel(model.public_id)).toBe(false);
      }
    });

    test('all Kilo exclusive models whose gateway is not openrouter must have inference_provider set', () => {
      // The enterprise provider selection screen filters models by inference_provider to determine
      // which provider a model belongs to. Without it, the screen cannot correctly display or
      // enforce provider-level allow/deny lists for models routed through non-OpenRouter gateways.
      const modelsWithDirectGateway = kiloExclusiveModels.filter(m => m.gateway !== 'openrouter');

      expect(modelsWithDirectGateway.length).toBeGreaterThan(0);

      for (const model of modelsWithDirectGateway) {
        expect(model.inference_provider).not.toBeNull();
      }
    });

    test('all Kilo exclusive models should have either no pricing or valid pricing', () => {
      // Verify that all kilo exclusive models have valid pricing structure
      for (const model of kiloExclusiveModels) {
        if (model.pricing) {
          expect(typeof model.pricing.prompt_per_million).toBe('number');
          expect(typeof model.pricing.completion_per_million).toBe('number');
          expect(typeof model.pricing.calculate_mUsd).toBe('function');
        }
      }
    });

    test('should return false for disabled Kilo exclusive models that do not end with :free', () => {
      const disabledModels = kiloExclusiveModels.filter(
        m => m.status === 'disabled' && !m.public_id.endsWith(':free')
      );

      // Disabled models without :free suffix should NOT be detected as free
      for (const model of disabledModels) {
        expect(isFreeModel(model.public_id)).toBe(false);
      }
    });

    test('all autoFreeModels should pass isFreeModel', () => {
      expect(autoFreeModels.length).toBeGreaterThan(0);
      for (const model of autoFreeModels) {
        expect(isFreeModel(model)).toBe(true);
      }
    });

    test('should return true for disabled Kilo exclusive models that end with :free', () => {
      const disabledModelsWithFreeSuffix = kiloExclusiveModels.filter(
        m => m.status === 'disabled' && m.public_id.endsWith(':free')
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
