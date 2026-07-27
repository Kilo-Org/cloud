import { describe, expect, test } from '@jest/globals';
import {
  familyHasForbiddenFreeModel,
  isForbiddenFreeModel,
} from '@/lib/ai-gateway/forbidden-free-models';

describe('forbidden free models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isForbiddenFreeModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(isForbiddenFreeModel('openai/gpt-oss-20b')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(familyHasForbiddenFreeModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(familyHasForbiddenFreeModel('openai/gpt-oss-20b')).toBe(true);
    expect(familyHasForbiddenFreeModel('cohere/north-mini-code')).toBe(false);
  });
});
