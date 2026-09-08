import { describe, expect, test } from '@jest/globals';
import {
  familyHasUnavailableFreeModel,
  isUnavailableModel,
} from '@/lib/ai-gateway/unavailable-models';

describe('unavailable models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isUnavailableModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(isUnavailableModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(isUnavailableModel('google/gemma-4-31b-it')).toBe(false);
    expect(isUnavailableModel('openai/gpt-oss-20b:free')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(familyHasUnavailableFreeModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-26b-a4b-it')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-31b-it')).toBe(true);
    expect(familyHasUnavailableFreeModel('cohere/north-mini-code')).toBe(false);
  });
});
