import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAgentProgressAllowedInActiveFocus } from './notification-focus-filter';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' as string },
  requireNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo', () => ({ requireNativeModule: mocks.requireNativeModule }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
});

describe('isAgentProgressAllowedInActiveFocus', () => {
  it('allows agent progress when the active iOS Focus stored the allowed choice', () => {
    mocks.requireNativeModule.mockReturnValue({ isAgentProgressAllowed: () => true });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
    expect(mocks.requireNativeModule).toHaveBeenCalledExactlyOnceWith('NotificationFocusFilter');
  });

  it('excludes agent progress when the active iOS Focus stored the excluded choice', () => {
    mocks.requireNativeModule.mockReturnValue({ isAgentProgressAllowed: () => false });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(false);
  });

  it('allows agent progress by default when the native module is missing', () => {
    mocks.requireNativeModule.mockImplementation(() => {
      throw new Error('Cannot find native module NotificationFocusFilter');
    });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
  });

  it('allows agent progress when the native read throws', () => {
    mocks.requireNativeModule.mockReturnValue({
      isAgentProgressAllowed: () => {
        throw new Error('shared container unavailable');
      },
    });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
  });

  it('allows agent progress on Android without consulting the native module', () => {
    mocks.platform.OS = 'android';
    mocks.requireNativeModule.mockReturnValue({ isAgentProgressAllowed: () => false });

    expect(isAgentProgressAllowedInActiveFocus()).toBe(true);
    expect(mocks.requireNativeModule).not.toHaveBeenCalled();
  });
});
