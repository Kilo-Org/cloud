import { describe, test, expect } from '@jest/globals';
import { isServerSideProductFeature, validateFeatureHeader } from './feature-detection';

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
    'quick-chat',
    'mobile-chat',
    'tool-summary-translation',
  ])('accepts emitted feature %s', feature => {
    expect(validateFeatureHeader(feature)).toBe(feature);
  });
});

describe('isServerSideProductFeature', () => {
  test('returns true for server-side products', () => {
    expect(isServerSideProductFeature('cloud-agent')).toBe(true);
    expect(isServerSideProductFeature('code-review')).toBe(true);
    expect(isServerSideProductFeature('app-builder')).toBe(true);
    expect(isServerSideProductFeature('gastown')).toBe(true);
  });

  test('returns false for client-side products', () => {
    expect(isServerSideProductFeature('vscode-extension')).toBe(false);
    expect(isServerSideProductFeature('jetbrains-extension')).toBe(false);
    expect(isServerSideProductFeature('cli')).toBe(false);
    expect(isServerSideProductFeature('direct-gateway')).toBe(false);
  });

  test('returns false for null', () => {
    expect(isServerSideProductFeature(null)).toBe(false);
  });
});
