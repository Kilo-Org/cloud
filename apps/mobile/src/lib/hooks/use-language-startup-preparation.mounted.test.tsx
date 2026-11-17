// The startup language preparation must run once per language-preference load:
// a navigation-readiness flip after preparation must not re-enter the direction
// step, the return-target read, the catalog activation, or the native
// notification calls. The readiness flip drives the deferred return-navigation
// effect only.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { useLanguageStartupPreparation } from './use-language-startup-preparation';

const mocks = vi.hoisted(() => ({
  renameAndroidNotificationChannels: vi.fn(),
  registerNeedsInputCategories: vi.fn(),
  activateLanguage: vi.fn(),
  runLanguageStartupDirectionGuardedAsync: vi.fn(),
  readLanguageReturnTarget: vi.fn(),
  setLanguageReady: vi.fn(),
}));

vi.mock('@/lib/hooks/use-language-preference', () => ({
  useLanguagePreference: () => ({ hasLoaded: true, preference: 'en' }),
  getResolvedLanguage: () => 'en',
}));
vi.mock('@/i18n/startup-direction-run', () => ({
  runLanguageStartupDirectionGuardedAsync: mocks.runLanguageStartupDirectionGuardedAsync.mockResolvedValue('applied'),
}));
vi.mock('@/i18n/activate-language', () => ({
  activateLanguage: mocks.activateLanguage.mockResolvedValue('loaded'),
}));
vi.mock('@/i18n/return-target', () => ({
  readLanguageReturnTarget: mocks.readLanguageReturnTarget.mockResolvedValue(null),
}));
vi.mock('@/lib/notifications', () => ({
  renameAndroidNotificationChannels: mocks.renameAndroidNotificationChannels.mockResolvedValue(undefined),
}));
vi.mock('@/lib/notification-actions', () => ({
  registerNeedsInputCategories: mocks.registerNeedsInputCategories.mockResolvedValue(undefined),
}));
vi.mock('expo', () => ({
  reloadAppAsync: vi.fn(),
  // expo-secure-store reads this at module scope; the hook's own dependencies
  // are all mocked, so the native module never loads beyond import time.
  requireNativeModule: vi.fn(() => ({})),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

// Stable across renders: the hook's effect lists `setLanguageReady` in its
// dependencies, so a fresh wrapper identity would re-run preparation.
const stableSetLanguageReady = (ready: boolean): void => {
  mocks.setLanguageReady(ready);
};

function Harness({ navigationReady }: Readonly<{ navigationReady: boolean }>): null {
  useLanguageStartupPreparation({
    navigationReady,
    setLanguageReady: stableSetLanguageReady,
  });
  return null;
}

/** Drains the preparation chain's microtask rounds inside act. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mounts the harness and re-renders it with a new readiness value inside act. */
function flipReady(renderer: TestRenderer.ReactTestRenderer, navigationReady: boolean): void {
  act(() => {
    renderer.update(createElement(Harness, { navigationReady }));
  });
}

function mountHarness(navigationReady: boolean): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, { navigationReady }));
  });
  if (!ref.current) {
    throw new Error('harness did not mount');
  }
  // prepareLanguage is async: flush its awaits before the first assertion.
  return flushMicrotasks().then(() => ref.current as TestRenderer.ReactTestRenderer);
}

beforeEach(() => {
  mocks.renameAndroidNotificationChannels.mockClear();
  mocks.registerNeedsInputCategories.mockClear();
  mocks.activateLanguage.mockClear();
  mocks.runLanguageStartupDirectionGuardedAsync.mockClear();
  mocks.readLanguageReturnTarget.mockClear();
  mocks.setLanguageReady.mockClear();
});

describe('useLanguageStartupPreparation', () => {
  it('runs the preparation once and does not re-enter when navigation readiness flips after it', async () => {
    // Launch ordering: the preference has loaded before the root navigator's
    // mount effects, so the layout first renders with readiness false.
    const renderer = await mountHarness(false);

    expect(mocks.runLanguageStartupDirectionGuardedAsync).toHaveBeenCalledTimes(1);
    expect(mocks.activateLanguage).toHaveBeenCalledTimes(1);
    expect(mocks.renameAndroidNotificationChannels).toHaveBeenCalledTimes(1);
    expect(mocks.registerNeedsInputCategories).toHaveBeenCalledTimes(1);
    expect(mocks.setLanguageReady).toHaveBeenCalledWith(true);

    // The readiness flip lands after preparation (navigator mount effects).
    flipReady(renderer, true);
    await flushMicrotasks();

    expect(mocks.renameAndroidNotificationChannels).toHaveBeenCalledTimes(1);
    expect(mocks.registerNeedsInputCategories).toHaveBeenCalledTimes(1);
    expect(mocks.runLanguageStartupDirectionGuardedAsync).toHaveBeenCalledTimes(1);
    expect(mocks.activateLanguage).toHaveBeenCalledTimes(1);
    expect(mocks.setLanguageReady).toHaveBeenCalledTimes(1);
  });
});
