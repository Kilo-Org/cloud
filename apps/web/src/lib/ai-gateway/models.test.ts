import { describe, test, expect } from '@jest/globals';
import {
  autoFreeModels,
  findKiloExclusiveModel,
  kiloExclusiveModels,
  isKiloExclusiveModelRequiringDataCollection,
} from './models';
import { isFreeModel } from './is-free-model';
import { getInferenceProvider } from './providers/kilo-exclusive-model';
import {
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
} from './providers/anthropic.constants';
import {
  isAlibabaDirectModel,
  qwen36_plus_model,
  qwen37_max_model,
  qwen37_plus_free_model,
  qwen37_plus_model,
} from './providers/qwen';
import { getModelVariants, REASONING_VARIANTS_BINARY } from './providers/model-settings';

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

    test('should return true for OpenRouter stealth models (alpha/beta)', async () => {
      expect(await isFreeModel('openrouter/model-alpha')).toBe(true);
      expect(await isFreeModel('openrouter/model-beta')).toBe(true);
      expect(await isFreeModel('openrouter/sonoma-dusk-alpha')).toBe(true);
      expect(await isFreeModel('openrouter/sonoma-sky-beta')).toBe(true);
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

    test('routes the discounted Claude Opus offering through the stealth provider identity', () => {
      expect(getInferenceProvider(claude_opus_4_7_stealth_model)).toBe('stealth');
      expect(claude_opus_4_7_stealth_model.public_id).toBe('stealth/claude-opus-4.7');
      expect(getInferenceProvider(claude_sonnet_4_6_stealth_model)).toBe('stealth');
      expect(claude_sonnet_4_6_stealth_model.public_id).toBe('stealth/claude-sonnet-4.6');
      expect(getInferenceProvider(claude_opus_4_6_stealth_model)).toBe('stealth');
      expect(claude_opus_4_6_stealth_model.public_id).toBe('stealth/claude-opus-4.6');
    });

    test('routes Qwen3.7 Max directly through Alibaba', () => {
      expect(findKiloExclusiveModel(qwen37_max_model.public_id)).toBe(qwen37_max_model);
      expect(isAlibabaDirectModel(qwen37_max_model.public_id)).toBe(true);
      expect(qwen37_max_model.gateway).toBe('alibaba');
      expect(qwen37_max_model.internal_id).toBe('qwen3.7-max');
      expect(getInferenceProvider(qwen37_max_model)).toBe('alibaba');
    });

    test('routes Qwen3.7 Plus directly through Alibaba', () => {
      expect(findKiloExclusiveModel(qwen37_plus_model.public_id)).toBe(qwen37_plus_model);
      expect(isAlibabaDirectModel(qwen37_plus_model.public_id)).toBe(true);
      expect(qwen37_plus_model.gateway).toBe('alibaba');
      expect(qwen37_plus_model.internal_id).toBe('qwen3.7-plus');
      expect(getInferenceProvider(qwen37_plus_model)).toBe('alibaba');
    });

    test('routes free Qwen3.7 Plus through Vercel with binary thinking variants', () => {
      expect(findKiloExclusiveModel(qwen37_plus_free_model.public_id)).toBe(qwen37_plus_free_model);
      expect(isAlibabaDirectModel(qwen37_plus_free_model.public_id)).toBe(false);
      expect(qwen37_plus_free_model.gateway).toBe('vercel');
      expect(qwen37_plus_free_model.internal_id).toBe('alibaba/qwen3.7-plus');
      expect(getInferenceProvider(qwen37_plus_free_model)).toBe(null);
      expect(getModelVariants(qwen37_plus_free_model.public_id)).toBe(REASONING_VARIANTS_BINARY);
    });

    test('requires data collection for paid training-enabled offerings', () => {
      expect(
        isKiloExclusiveModelRequiringDataCollection(claude_opus_4_7_stealth_model.public_id)
      ).toBe(true);
      expect(
        isKiloExclusiveModelRequiringDataCollection(claude_sonnet_4_6_stealth_model.public_id)
      ).toBe(true);
      expect(
        isKiloExclusiveModelRequiringDataCollection(claude_opus_4_6_stealth_model.public_id)
      ).toBe(true);
      expect(isKiloExclusiveModelRequiringDataCollection(qwen36_plus_model.public_id)).toBe(false);
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
      for (const model of autoFreeModels) {
        expect(await isFreeModel(model)).toBe(true);
      }
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

    test('should return false for OpenRouter models that do not end with -alpha or -beta', async () => {
      expect(await isFreeModel('openrouter/model')).toBe(false);
      expect(await isFreeModel('openrouter/model-gamma')).toBe(false);
      expect(await isFreeModel('openrouter/model-stable')).toBe(false);
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
      expect(await isFreeModel('openrouter/model-ALPHA')).toBe(false);
    });

    test('should handle whitespace correctly', async () => {
      expect(await isFreeModel('model:free ')).toBe(false);
      expect(await isFreeModel(' model:free')).toBe(true);
      expect(await isFreeModel(' openrouter/free')).toBe(false);
      expect(await isFreeModel('openrouter/free ')).toBe(false);
      expect(await isFreeModel('openrouter/model-alpha ')).toBe(false);
    });
  });
});
