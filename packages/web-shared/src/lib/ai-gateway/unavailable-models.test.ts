import { describe, expect, test } from '@jest/globals';
import {
  familyHasUnavailableFreeModel,
  isUnavailableModel,
} from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';

describe('unavailable models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isUnavailableModel('apodex/apodex-1.1-mini:free')).toBe(true);
    expect(isUnavailableModel('apodex/apodex-1.1-mini')).toBe(false);
    expect(isUnavailableModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(isUnavailableModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(isUnavailableModel('google/gemma-4-31b-it')).toBe(false);
    expect(isUnavailableModel('qwen/qwen3.8-27b:free')).toBe(true);
    expect(isUnavailableModel('qwen/qwen3.8-27b')).toBe(false);
    expect(isUnavailableModel('openai/gpt-oss-20b:free')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(familyHasUnavailableFreeModel('apodex/apodex-1.1-mini:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('apodex/apodex-1.1-mini')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-26b-a4b-it')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-31b-it')).toBe(true);
    expect(familyHasUnavailableFreeModel('qwen/qwen3.8-27b:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('qwen/qwen3.8-27b')).toBe(true);
    expect(familyHasUnavailableFreeModel('cohere/north-mini-code')).toBe(false);
  });
});
