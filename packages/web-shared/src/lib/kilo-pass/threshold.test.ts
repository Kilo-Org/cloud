import { describe, expect, test } from '@jest/globals';

import { getEffectiveKiloPassThreshold } from './threshold';

describe('getEffectiveKiloPassThreshold', () => {
  test('returns null for null input', () => {
    expect(getEffectiveKiloPassThreshold(null)).toBeNull();
  });

  test('clamps negative effective threshold to 0', () => {
    expect(getEffectiveKiloPassThreshold(0)).toBe(0);
    expect(getEffectiveKiloPassThreshold(500_000)).toBe(0);
    expect(getEffectiveKiloPassThreshold(1_000_000)).toBe(0);
  });

  test('subtracts $1 when threshold is above $1', () => {
    expect(getEffectiveKiloPassThreshold(1_200_000)).toBe(200_000);
    expect(getEffectiveKiloPassThreshold(19_000_000)).toBe(18_000_000);
  });
});
