import { describe, expect, it, vi } from 'vitest';

import { currentAppVersion } from './feature-flags';

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

describe('currentAppVersion', () => {
  it('reads the running build version, null when absent', () => {
    hoisted.nativeApplicationVersion = '1.0.8';
    expect(currentAppVersion()).toBe('1.0.8');
    hoisted.nativeApplicationVersion = undefined;
    expect(currentAppVersion()).toBeNull();
  });
});
