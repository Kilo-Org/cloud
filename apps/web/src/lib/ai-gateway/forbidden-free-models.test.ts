import { describe, expect, test } from '@jest/globals';
import {
  isForbiddenFreeModel,
  isForbiddenFreeModelFamily,
} from '@/lib/ai-gateway/forbidden-free-models';

describe('forbidden free models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isForbiddenFreeModel('openai/gpt-oss-20b:free')).toBe(true);
    expect(isForbiddenFreeModel('openai/gpt-oss-20b')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(isForbiddenFreeModelFamily('openai/gpt-oss-20b:free')).toBe(true);
    expect(isForbiddenFreeModelFamily('openai/gpt-oss-20b')).toBe(true);
    expect(isForbiddenFreeModelFamily('cohere/north-mini-code')).toBe(false);
  });
});
