import { afterEach, describe, expect, it, vi } from 'vitest';

import { installProtectedDataSource } from '@/lib/protected-data-native';
import { isProtectedDataAvailable, setProtectedDataAvailable } from '@/lib/protected-data';

type ChangeListener = (event: { available: boolean }) => void;

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

function fakeModule(availableAtLaunch: boolean) {
  const listeners: ChangeListener[] = [];
  return {
    module: {
      isProtectedDataAvailable: () => availableAtLaunch,
      addListener: (_event: string, listener: ChangeListener) => {
        listeners.push(listener);
        return { remove: () => undefined };
      },
    },
    emit: (available: boolean) => {
      for (const listener of listeners) {
        listener({ available });
      }
    },
  };
}

afterEach(() => {
  setProtectedDataAvailable(true);
});

describe('installProtectedDataSource', () => {
  it('keeps the data available when the platform has no module', () => {
    native.requireOptionalNativeModule.mockReturnValue(null);

    installProtectedDataSource();

    expect(native.requireOptionalNativeModule).toHaveBeenCalledWith('KiloProtectedData');
    expect(isProtectedDataAvailable()).toBe(true);
  });

  it('records a locked launch and follows the native changes', () => {
    const fake = fakeModule(false);
    native.requireOptionalNativeModule.mockReturnValue(fake.module);

    installProtectedDataSource();
    expect(isProtectedDataAvailable()).toBe(false);

    fake.emit(true);
    expect(isProtectedDataAvailable()).toBe(true);

    fake.emit(false);
    expect(isProtectedDataAvailable()).toBe(false);
  });
});
