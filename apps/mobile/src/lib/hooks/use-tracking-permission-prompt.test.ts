/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
import { createElement, type FC } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getTrackingPermissionsAsync, requestTrackingPermissionsAsync } = vi.hoisted(() => ({
  getTrackingPermissionsAsync: vi.fn<() => Promise<{ status: string }>>(),
  requestTrackingPermissionsAsync: vi.fn<() => Promise<{ status: string }>>(),
}));
vi.mock('expo-tracking-transparency', () => ({
  getTrackingPermissionsAsync,
  requestTrackingPermissionsAsync,
  PermissionStatus: {
    UNDETERMINED: 'undetermined',
    DENIED: 'denied',
    GRANTED: 'granted',
  } as const,
}));

const { alertMock } = vi.hoisted(() => ({ alertMock: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Alert: { alert: alertMock },
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

// The dismissed preference loads through secure-store-preference, whose chain
// reaches expo-secure-store, sonner-native and the bundle-time config. Stub
// them the way secure-store-preference.test.ts does.
const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string, options?: unknown) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, options?: unknown) => Promise<void>>(),
  deleteItemAsync: vi.fn<(key: string, options?: unknown) => Promise<void>>(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));
const configStub = vi.hoisted(() => new Proxy({}, { get: () => undefined, has: () => true }));
vi.mock('@/lib/config', () => configStub);

import {
  clearTrackingPromptDismissed,
  useTrackingPermissionPrompt,
} from './use-tracking-permission-prompt';

type AlertButton = { text: string; style?: string; onPress?: () => void };

// A thin React component that calls the hook for testing.
const TestHarness: FC<{ enabled: boolean }> = ({ enabled }) => {
  useTrackingPermissionPrompt(enabled);
  return null;
};

function mountHarness(enabled: boolean): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(TestHarness, { enabled }));
  });
  // act() is synchronous; renderer is assigned inside the callback.
  return renderer as unknown as TestRenderer.ReactTestRenderer;
}

// Helper to produce a controllable promise without uninitialized variables.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return Promise.withResolvers<T>();
}

function getAlertButtons(): [AlertButton, AlertButton] {
  expect(alertMock).toHaveBeenCalledOnce();
  const call = alertMock.mock.calls[0] as unknown[];
  expect(call[0]).toBe('Allow install attribution?');
  expect(call[1]).toBe(
    "Kilo uses Apple's tracking permission only to learn which channel brought you here. Your prompts and conversations are never used."
  );
  const buttons = call[2] as AlertButton[];
  expect(buttons).toHaveLength(2);
  return buttons as [AlertButton, AlertButton];
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setImmediate(() => {
    resolve(undefined);
  });
  return promise;
}

describe('useTrackingPermissionPrompt', () => {
  beforeEach(() => {
    getTrackingPermissionsAsync.mockReset();
    requestTrackingPermissionsAsync.mockReset();
    alertMock.mockReset();
    captureException.mockReset();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    // Default: nothing persisted, so the preference reads its default value.
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockResolvedValue(undefined);
    deleteItemAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Gate false: no pre-prompt.
  it('does nothing when enabled is false', async () => {
    const renderer = mountHarness(false);
    // Flush any microtasks so async effects can settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(getTrackingPermissionsAsync).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    renderer.unmount();
  });

  // Status decided: no pre-prompt.
  it.each([
    { label: 'denied', status: 'denied' },
    { label: 'granted', status: 'granted' },
  ])('shows no alert when status is already $label', async ({ status }) => {
    getTrackingPermissionsAsync.mockResolvedValue({ status });

    const renderer = mountHarness(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getTrackingPermissionsAsync).toHaveBeenCalledOnce();
    expect(alertMock).not.toHaveBeenCalled();
    expect(requestTrackingPermissionsAsync).not.toHaveBeenCalled();
    renderer.unmount();
  });

  // Happy: Continue is tapped and the system dialog appears.
  it('shows the pre-prompt alert when status is undetermined and calls requestTrackingPermissionsAsync on Continue', async () => {
    getTrackingPermissionsAsync.mockResolvedValue({
      status: 'undetermined',
    });
    requestTrackingPermissionsAsync.mockResolvedValue({ status: 'granted' });

    const renderer = mountHarness(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getTrackingPermissionsAsync).toHaveBeenCalledOnce();

    const [notNowButton, continueButton] = getAlertButtons();
    expect(notNowButton.text).toBe('Not now');
    expect(notNowButton.style).toBe('cancel');
    expect(continueButton.text).toBe('Continue');
    expect(requestTrackingPermissionsAsync).not.toHaveBeenCalled();

    // Tap Continue.
    await act(async () => {
      continueButton.onPress?.();
      await Promise.resolve();
    });

    expect(requestTrackingPermissionsAsync).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  // Not now: proves no tracking system request is made.
  it('does not request tracking permission when Not now is tapped', async () => {
    getTrackingPermissionsAsync.mockResolvedValue({
      status: 'undetermined',
    });

    const renderer = mountHarness(true);
    await act(async () => {
      await Promise.resolve();
    });

    const buttons = getAlertButtons();
    const notNowButton = buttons[0];
    expect(notNowButton.text).toBe('Not now');

    // Tap Not now.
    await act(async () => {
      notNowButton.onPress?.();
      await Promise.resolve();
    });

    expect(requestTrackingPermissionsAsync).not.toHaveBeenCalled();
    renderer.unmount();

    // Not now persists the dismissal so later mounts never see the alert.
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('tracking-prompt-dismissed', 'true');

    // The store is module-level: reset it so later tests start undismissed.
    clearTrackingPromptDismissed();
    await flushMicrotasks();
  });

  // Remembered dismissal: a launch with the flag persisted shows no alert.
  // The preference store is module-level and caches after its first load, so
  // this test resets the module registry and imports the hook dynamically:
  // a static import would reuse a store that already resolved its disk read
  // in an earlier test and would never see the seeded value.
  it('does not show the pre-prompt again on a later launch after Not now was persisted', async () => {
    getItemAsync.mockResolvedValue('true');
    getTrackingPermissionsAsync.mockResolvedValue({ status: 'undetermined' });

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      vi.resetModules();
      const { useTrackingPermissionPrompt: freshHook } = await import(
        './use-tracking-permission-prompt'
      );
      const FreshHarness: FC<{ enabled: boolean }> = ({ enabled }) => {
        freshHook(enabled);
        return null;
      };
      renderer = TestRenderer.create(createElement(FreshHarness, { enabled: true }));
      await flushMicrotasks();
    });

    expect(alertMock).not.toHaveBeenCalled();
    expect(requestTrackingPermissionsAsync).not.toHaveBeenCalled();
    // The hook skips the ATT read entirely once the dismissal is on disk.
    expect(getTrackingPermissionsAsync).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- renderer assigned inside act
    (renderer as unknown as TestRenderer.ReactTestRenderer).unmount();
  });

  // A fast ATT check must not win the race against the asynchronous flag read:
  // the hook awaits the flag load before consulting ATT, so the alert stays
  // hidden when the flag lands after the mount.
  it('still suppresses the alert when the flag read resolves after the mount', async () => {
    const { promise: diskPromise, resolve: resolveDisk } =
      Promise.withResolvers<string | null>();
    getItemAsync.mockReturnValue(diskPromise);
    getTrackingPermissionsAsync.mockResolvedValue({ status: 'undetermined' });

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      vi.resetModules();
      const { useTrackingPermissionPrompt: freshHook } = await import(
        './use-tracking-permission-prompt'
      );
      const FreshHarness: FC<{ enabled: boolean }> = ({ enabled }) => {
        freshHook(enabled);
        return null;
      };
      renderer = TestRenderer.create(createElement(FreshHarness, { enabled: true }));
      await Promise.resolve();
    });
    expect(alertMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveDisk('true');
      await flushMicrotasks();
    });

    expect(alertMock).not.toHaveBeenCalled();
    expect(requestTrackingPermissionsAsync).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- renderer assigned inside act
    (renderer as unknown as TestRenderer.ReactTestRenderer).unmount();
  });

  // Request failure: Sentry receives error; no rethrow or retry.
  it('reports errors to Sentry and does not rethrow when requestTrackingPermissionsAsync fails', async () => {
    getTrackingPermissionsAsync.mockResolvedValue({
      status: 'undetermined',
    });
    const requestError = new Error('ATT request failed');
    requestTrackingPermissionsAsync.mockRejectedValue(requestError);

    const renderer = mountHarness(true);
    await act(async () => {
      await Promise.resolve();
    });

    const buttons = getAlertButtons();
    const continueButton = buttons[1] as AlertButton | undefined;
    if (!continueButton?.onPress) {
      throw new Error('Expected Continue button with onPress handler');
    }

    // Must not throw.
    await act(async () => {
      continueButton.onPress?.();
      await Promise.resolve();
    });

    expect(captureException).toHaveBeenCalledWith(requestError, {
      tags: {
        'error.subsystem': 'tracking_permission',
        'error.operation': 'request_permission',
      },
    });
    renderer.unmount();
  });

  // getTrackingPermissionsAsync failure: error reported to Sentry, no alert shown.
  it('reports errors to Sentry when getTrackingPermissionsAsync fails and shows no alert', async () => {
    const checkError = new Error('ATT check failed');
    getTrackingPermissionsAsync.mockRejectedValue(checkError);

    const renderer = mountHarness(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getTrackingPermissionsAsync).toHaveBeenCalledOnce();
    expect(alertMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(checkError, {
      tags: { 'error.subsystem': 'tracking_permission', 'error.operation': 'get_permission' },
    });
    renderer.unmount();
  });

  // Cancellation: a late status result cannot show Alert after disable.
  it('does not show Alert when enabled becomes false before status resolves', async () => {
    const { promise: statusPromise, resolve: resolveStatus } = deferred<{ status: string }>();
    getTrackingPermissionsAsync.mockReturnValue(statusPromise);

    const renderer = mountHarness(true);

    // Let the effect start but the promise is pending.
    await act(async () => {
      await Promise.resolve();
    });
    expect(getTrackingPermissionsAsync).toHaveBeenCalledOnce();

    // Disable before the status resolves.
    act(() => {
      renderer.update(createElement(TestHarness, { enabled: false }));
    });

    // Now resolve the status — it arrives after disable.
    await act(async () => {
      resolveStatus({ status: 'undetermined' });
      await Promise.resolve();
    });

    expect(alertMock).not.toHaveBeenCalled();
    renderer.unmount();
  });

  // Unmount: a late status result cannot show Alert after unmount.
  it('does not show Alert when the component unmounts before status resolves', async () => {
    const { promise: statusPromise, resolve: resolveStatus } = deferred<{ status: string }>();
    getTrackingPermissionsAsync.mockReturnValue(statusPromise);

    const renderer = mountHarness(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(getTrackingPermissionsAsync).toHaveBeenCalledOnce();

    // Unmount before the status resolves.  act() must flush so the
    // effect cleanup runs before we resolve the pending promise.
    act(() => {
      renderer.unmount();
    });

    await act(async () => {
      resolveStatus({ status: 'undetermined' });
      await Promise.resolve();
    });

    expect(alertMock).not.toHaveBeenCalled();
  });
});
