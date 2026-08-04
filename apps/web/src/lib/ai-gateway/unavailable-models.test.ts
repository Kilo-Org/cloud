import { describe, expect, test } from '@jest/globals';
import {
  familyHasUnavailableFreeModel,
  isUnavailableModel,
} from '@/lib/ai-gateway/unavailable-models';

describe('unavailable models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isUnavailableModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(isUnavailableModel('sakana/fugu-ultra')).toBe(false);
    expect(isUnavailableModel('byteplus-coding/glm-4.7')).toBe(true);
    expect(isUnavailableModel('openai/gpt-oss-20b')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(familyHasUnavailableFreeModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('openai/gpt-oss-20b')).toBe(true);
    expect(familyHasUnavailableFreeModel('cohere/north-mini-code')).toBe(false);
  });

  test('ignores families of unavailable models that are not free', () => {
    expect(familyHasUnavailableFreeModel('giga-potato')).toBe(false);
  });
});
