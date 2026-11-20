// The startup language step must end on the resolved language even when a
// `languageChanged` listener throws. i18next emits that event synchronously
// inside `changeLanguage`, after the catalog is in the store — the native
// glanceable refreshes re-register widget and live-activity surfaces from the
// listener, and a native host function that throws rejects the change.
// Treating that rejection as a catalog failure applied English instead, so a
// device set to a non-English language painted the whole app in English after
// a relaunch.
//
// This suite uses the real i18n instance and the real `activateLanguage`, so
// it pins the user-visible outcome (which catalog the app runs) rather than a
// call count.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { useLanguageStartupPreparation } from './use-language-startup-preparation';

const mocks = vi.hoisted(() => ({ setLanguageReady: vi.fn() }));

// The resolved language is Arabic, which is what an ar-EG device with the
// preference at `device` produces.
vi.mock('@/lib/hooks/use-language-preference', () => ({
  useLanguagePreference: () => ({ hasLoaded: true, preference: 'device' }),
  getResolvedLanguage: () => 'ar',
}));
vi.mock('@/i18n/startup-direction-run', () => ({
  // The running direction already matches, which is the device state after the
  // first RTL launch: the step applies the catalog in place, no reload.
  runLanguageStartupDirectionGuardedAsync: vi.fn(() => Promise.resolve('applied')),
}));
vi.mock('@/i18n/return-target', () => ({
  readLanguageReturnTarget: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/notifications', () => ({
  renameAndroidNotificationChannels: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/notification-actions', () => ({
  registerNeedsInputCategories: vi.fn(() => Promise.resolve()),
}));
vi.mock('expo', () => ({
  reloadAppAsync: vi.fn(),
  requireNativeModule: vi.fn(() => ({})),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
// The device's native direction is right to left on an Arabic device.
vi.mock('react-native', () => ({ I18nManager: { isRTL: true } }));

const stableSetLanguageReady = (ready: boolean): void => {
  mocks.setLanguageReady(ready);
};

function Harness(): null {
  useLanguageStartupPreparation({
    navigationReady: true,
    setLanguageReady: stableSetLanguageReady,
  });
  return null;
}

const throwsOnLanguageChange = (): void => {
  throw new Error('native widget registration failed');
};

/** Drains the preparation chain's awaits inside act. */
async function mountPrepared(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  await act(async () => {
    // The chain crosses several awaits (direction step, return-target read,
    // catalog activation, the notification pass). Each round yields to the
    // macrotask queue once; `Promise.all` over the rounds keeps them ordered
    // while avoiding a sequential await inside the loop.
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
      })
    );
  });
  if (!ref.current) {
    throw new Error('harness did not mount');
  }
  return ref.current;
}

beforeEach(() => {
  mocks.setLanguageReady.mockClear();
});

afterEach(async () => {
  i18n.off('languageChanged', throwsOnLanguageChange);
  await i18n.changeLanguage('en');
});

describe('useLanguageStartupPreparation with a throwing language-changed listener', () => {
  it('keeps the resolved catalog active instead of falling back to English', async () => {
    // A catalog load under vitest resolves on a later turn than Metro's
    // synchronous `require`, so both catalogs are warmed first: the device path
    // is a bundle-store hit inside `changeLanguage`, where the listener's throw
    // is what rejects the change.
    await i18n.changeLanguage('ar');
    await i18n.changeLanguage('en');
    i18n.on('languageChanged', throwsOnLanguageChange);

    const renderer = await mountPrepared();

    // The app runs the device language and the gate lifts so the tree paints
    // it: the startup path did not read the listener's throw as a failure.
    expect(i18n.language).toBe('ar');
    expect(i18n.resolvedLanguage).toBe('ar');
    expect(i18n.hasResourceBundle('ar', 'translation')).toBe(true);
    expect(mocks.setLanguageReady).toHaveBeenCalledWith(true);

    renderer.unmount();
  });
});
