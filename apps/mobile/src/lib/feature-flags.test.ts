import { describe, expect, it, vi } from 'vitest';

import { compareAppVersions, currentAppVersion, isAppVersionAtLeast } from './feature-flags';

// expo-application is a native module whose source pulls in react-native
// (Flow-typed), which the pure vitest pipeline cannot parse. Mock it with a
// mutable version so the gate is tested against the build under test.
// (vi.mock is hoisted above the imports by vitest.)
const hoisted = vi.hoisted(() => ({
  nativeApplicationVersion: '1.0.8' as string | undefined,
}));
vi.mock('expo-application', () => ({
  get nativeApplicationVersion() {
    return hoisted.nativeApplicationVersion;
  },
}));

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

describe('currentAppVersion', () => {
  it('reads the running build version, null when absent', () => {
    hoisted.nativeApplicationVersion = '1.0.8';
    expect(currentAppVersion()).toBe('1.0.8');
    hoisted.nativeApplicationVersion = undefined;
    expect(currentAppVersion()).toBeNull();
  });
});
