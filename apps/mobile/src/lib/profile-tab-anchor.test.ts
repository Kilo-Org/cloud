import { describe, expect, it, vi } from 'vitest';

import { unstable_settings } from '../app/(app)/(tabs)/(3_profile)/_layout';

vi.mock('expo-router', () => ({
  Stack: () => null,
}));

describe('profile tab layout anchor', () => {
  it('anchors the profile tab to its index route', () => {
    expect(unstable_settings.initialRouteName).toBe('index');
  });
});
