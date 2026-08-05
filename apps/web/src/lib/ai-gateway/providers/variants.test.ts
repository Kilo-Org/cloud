import { describe, expect, test } from '@jest/globals';

import {
  getFallbackModelVariants,
  REASONING_VARIANTS_BINARY,
  REASONING_VARIANTS_NONE_MEDIUM_HIGH,
} from '@/lib/ai-gateway/providers/variants';

describe('getFallbackModelVariants', () => {
  test.each([
    'google/gemma-4-26b-a4b-it',
    'poolside/laguna-s-2.1:free',
    'inclusionai/ling-3.0-flash:free',
  ])('returns binary variants for %s', model => {
    expect(getFallbackModelVariants(model)).toBe(REASONING_VARIANTS_BINARY);
  });

  test('returns the latest Nemotron family variants', () => {
    expect(getFallbackModelVariants('nvidia/nemotron-3-super-120b-a12b:free')).toBe(
      REASONING_VARIANTS_NONE_MEDIUM_HIGH
    );
  });

  test('uses max reasoning effort for the Claude max variant', () => {
    expect(getFallbackModelVariants('anthropic/claude-opus-5')).toMatchObject({
      max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
    });
  });
});
