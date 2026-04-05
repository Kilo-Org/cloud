import { describe, test, expect } from '@jest/globals';
import { isUserRateLimitedFeature, validateFeatureHeader } from './feature-detection';

describe('validateFeatureHeader', () => {
  test('returns null for null input', () => {
    expect(validateFeatureHeader(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(validateFeatureHeader('')).toBeNull();
  });

  test('returns null for invalid feature', () => {
    expect(validateFeatureHeader('unknown-feature')).toBeNull();
  });

  test('returns normalized feature for valid input', () => {
    expect(validateFeatureHeader('cloud-agent')).toBe('cloud-agent');
    expect(validateFeatureHeader('  Cloud-Agent  ')).toBe('cloud-agent');
  });
});

describe('isUserRateLimitedFeature', () => {
  test('returns true for server-side products', () => {
    expect(isUserRateLimitedFeature('cloud-agent')).toBe(true);
    expect(isUserRateLimitedFeature('code-review')).toBe(true);
    expect(isUserRateLimitedFeature('app-builder')).toBe(true);
  });

  test('returns false for client-side products', () => {
    expect(isUserRateLimitedFeature('vscode-extension')).toBe(false);
    expect(isUserRateLimitedFeature('jetbrains-extension')).toBe(false);
    expect(isUserRateLimitedFeature('cli')).toBe(false);
    expect(isUserRateLimitedFeature('direct-gateway')).toBe(false);
  });

  test('returns false for null', () => {
    expect(isUserRateLimitedFeature(null)).toBe(false);
  });
});
