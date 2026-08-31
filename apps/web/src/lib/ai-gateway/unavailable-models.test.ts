import { describe, expect, test } from '@jest/globals';
import {
  familyHasUnavailableFreeModel,
  isUnavailableModel,
} from '@/lib/ai-gateway/unavailable-models';

describe('unavailable models', () => {
  test('keeps exact matching for request rejection', () => {
    expect(isUnavailableModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(isUnavailableModel('sakana/fugu-ultra')).toBe(false);
    expect(isUnavailableModel('google/gemma-4-31b-it:free')).toBe(true);
    expect(isUnavailableModel('google/gemma-4-26b-a4b-it')).toBe(false);
    expect(isUnavailableModel('z-ai/glm-5.2:free')).toBe(true);
    expect(isUnavailableModel('z-ai/glm-5.2')).toBe(false);
  });

  test('matches normalized families for provider metadata', () => {
    expect(familyHasUnavailableFreeModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('google/gemma-4-26b-a4b-it')).toBe(true);
    expect(familyHasUnavailableFreeModel('cohere/north-mini-code')).toBe(false);
    expect(familyHasUnavailableFreeModel('z-ai/glm-5.2:free')).toBe(true);
    expect(familyHasUnavailableFreeModel('z-ai/glm-5.2')).toBe(true);
  });

  test.each([
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'nvidia/nemotron-nano-9b-v2:free',
    'openai/gpt-oss-20b:free',
    'tencent/hy3:free',
  ])('does not explicitly block delisted model %s', modelId => {
    expect(isUnavailableModel(modelId)).toBe(false);
    expect(familyHasUnavailableFreeModel(modelId)).toBe(false);
  });
});
