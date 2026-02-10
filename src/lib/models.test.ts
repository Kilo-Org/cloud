import { describe, test, expect } from '@jest/globals';
import { getFirstFreeModel, isFreeModel } from './models';

describe('isFreeModel', () => {
  describe('free models', () => {
    test('should return false for former stealth models', () => {
      expect(isFreeModel('sonic')).toBe(false);
      expect(isFreeModel('openrouter/sonoma-dusk-alpha')).toBe(false);
      expect(isFreeModel('openrouter/sonoma-sky-alpha')).toBe(false);
    });

    test('should return true for models ending with :free', () => {
      expect(isFreeModel('gpt-4:free')).toBe(true);
      expect(isFreeModel('claude-3:free')).toBe(true);
      expect(isFreeModel('some-model:free')).toBe(true);
      expect(isFreeModel(':free')).toBe(true);
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

    test('should return false for models that contain "sonic" but are not exactly "sonic"', () => {
      expect(isFreeModel('sonic-pro')).toBe(false);
      expect(isFreeModel('supersonic')).toBe(false);
      expect(isFreeModel('sonic/v2')).toBe(false);
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
      expect(isFreeModel('SONIC')).toBe(false);
      expect(isFreeModel('Sonic')).toBe(false);
      expect(isFreeModel('model:FREE')).toBe(false);
      expect(isFreeModel('model:Free')).toBe(false);
    });

    test('should handle whitespace correctly', () => {
      expect(isFreeModel(' sonic')).toBe(false);
      expect(isFreeModel('sonic ')).toBe(false);
      expect(isFreeModel(' sonic ')).toBe(false);
      expect(isFreeModel('model:free ')).toBe(false);
      expect(isFreeModel(' model:free')).toBe(true);
    });
  });
});

describe('getFirstFreeModel', () => {
  test('should return a model that is actually free', () => {
    const firstFreeModel = getFirstFreeModel();
    expect(isFreeModel(firstFreeModel)).toBe(true);
  });
});
