import { describe, test, expect } from '@jest/globals';
import { validateFeatureHeader } from './feature-detection';

describe('validateFeatureHeader', () => {
  test('returns null for null input', () => {
    expect(validateFeatureHeader(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(validateFeatureHeader('')).toBeNull();
  });

  test('returns null for invalid feature', () => {
    expect(validateFeatureHeader('unknown-feature')).toBeNull();
    expect(validateFeatureHeader('unknown')).toBeNull();
  });

  test('returns normalized feature for valid input', () => {
    expect(validateFeatureHeader('cloud-agent')).toBe('cloud-agent');
    expect(validateFeatureHeader('  Cloud-Agent  ')).toBe('cloud-agent');
  });

  test.each([
    'jetbrains-plugin',
    'daemon',
    'code-review-memory',
    'security-remediation',
    'github',
    'linear',
    'scheduled',
  ])('accepts emitted feature %s', feature => {
    expect(validateFeatureHeader(feature)).toBe(feature);
  });
});
