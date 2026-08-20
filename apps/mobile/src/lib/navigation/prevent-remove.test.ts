import { describe, expect, it, vi } from 'vitest';

import { usePreventRemove } from './prevent-remove';

// The vendored expo-router/react-navigation tree imports react-native, which
// cannot load in the pure node vitest environment. Mock the deep import so the
// re-export wiring is asserted without pulling in the native runtime. A path
// move in expo-router is caught by `tsgo --noEmit` at build time; this test
// pins that the re-export resolves to a function.
vi.mock('expo-router/build/react-navigation', () => ({
  usePreventRemove: vi.fn(),
}));

describe('prevent-remove re-export', () => {
  it('re-exports usePreventRemove from the vendored expo-router path', () => {
    expect(typeof usePreventRemove).toBe('function');
  });
});
