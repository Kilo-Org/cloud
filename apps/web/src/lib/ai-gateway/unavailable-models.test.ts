import { describe, expect, test } from '@jest/globals';
import { familyHasUnavailableModel, isUnavailableModel } from '@/lib/ai-gateway/unavailable-models';

describe('unavailable models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isUnavailableModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(isUnavailableModel('openai/gpt-oss-20b')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(familyHasUnavailableModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(familyHasUnavailableModel('openai/gpt-oss-20b')).toBe(true);
    expect(familyHasUnavailableModel('cohere/north-mini-code')).toBe(false);
  });
});
