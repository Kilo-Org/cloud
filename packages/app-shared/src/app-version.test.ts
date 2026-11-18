import { describe, expect, it } from 'vitest';

import { compareAppVersions, isAppVersionAtLeast, isVersionBelow } from './app-version';

describe('isVersionBelow', () => {
  it('returns true when current is below minimum', () => {
    expect(isVersionBelow('1.0.3', '1.0.4')).toBe(true);
    expect(isVersionBelow('1.9.0', '2.0.0')).toBe(true);
  });

  it('returns false when current equals minimum', () => {
    expect(isVersionBelow('1.0.4', '1.0.4')).toBe(false);
  });

  it('returns false when current is above minimum', () => {
    expect(isVersionBelow('1.0.5', '1.0.4')).toBe(false);
    expect(isVersionBelow('2.0.0', '1.9.9')).toBe(false);
  });

  it('treats a missing segment as 0', () => {
    expect(isVersionBelow('1', '1.0.0')).toBe(false);
    expect(isVersionBelow('1', '1.0.1')).toBe(true);
  });

  it('treats a non-numeric segment as 0', () => {
    // "1.x" coerces to "1.0"
    expect(isVersionBelow('1.x', '1.0.0')).toBe(false);
    expect(isVersionBelow('1.x', '1.1.0')).toBe(true);
    expect(isVersionBelow('1.x', '2.0.0')).toBe(true);
  });
});

describe('compareAppVersions', () => {
  it.each([
    ['1.0.8', '1.0.8', 0],
    ['1.0.8', '1.0.4', 1],
    ['1.0.4', '1.0.8', -1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.0', '1.0.0', 0],
    ['1', '1.0.1', -1],
    ['0.9', '1.0.0', -1],
  ] as const)('compares %s vs %s', (a, b, expected) => {
    expect(compareAppVersions(a, b)).toBe(expected);
  });

  it('treats non-numeric segments as zero instead of throwing', () => {
    expect(compareAppVersions('1.0.x', '1.0.0')).toBe(0);
  });
});

describe('isAppVersionAtLeast', () => {
  it('clears the gate at and above the minimum', () => {
    expect(isAppVersionAtLeast('1.0.6', '1.0.6')).toBe(true);
    expect(isAppVersionAtLeast('1.0.8', '1.0.6')).toBe(true);
    expect(isAppVersionAtLeast('2.0.0', '1.0.6')).toBe(true);
  });

  it('holds the gate below the minimum and for an unknown version', () => {
    expect(isAppVersionAtLeast('1.0.5', '1.0.6')).toBe(false);
    expect(isAppVersionAtLeast('0.9.9', '1.0.6')).toBe(false);
    expect(isAppVersionAtLeast(null, '1.0.6')).toBe(false);
    expect(isAppVersionAtLeast(undefined, '1.0.6')).toBe(false);
    expect(isAppVersionAtLeast('', '1.0.6')).toBe(false);
  });
});
