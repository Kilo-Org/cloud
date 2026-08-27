/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrivacyCoverOverlay } from './privacy-cover-overlay';

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'android' as string },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

// Records the native calls in order, so the test can prove prevent and allow
// stay paired instead of only counting them.
const captureMock = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('react-native', () => ({
  Platform: reactNativeMock.Platform,
  AppState: reactNativeMock.AppState,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: (build: () => unknown) => build(),
}));
vi.mock('expo-router', () => ({ useSegments: () => [] }));
vi.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: async () => {
    captureMock.calls.push('prevent');
    await Promise.resolve();
  },
  allowScreenCaptureAsync: async () => {
    captureMock.calls.push('allow');
    await Promise.resolve();
  },
}));

async function render(segments: readonly string[]): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(PrivacyCoverOverlay, { segments }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function update(
  renderer: TestRenderer.ReactTestRenderer,
  segments: readonly string[]
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(PrivacyCoverOverlay, { segments }));
  });
}

beforeEach(() => {
  reactNativeMock.Platform.OS = 'android';
  captureMock.calls = [];
});

describe('PrivacyCoverOverlay screen capture', () => {
  it('blocks capture on a covered route and releases it on unmount', async () => {
    const renderer = await render(['(app)', '(tabs)', '(3_profile)']);
    expect(captureMock.calls).toEqual(['prevent']);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
    expect(captureMock.calls).toEqual(['prevent', 'allow']);
  });

  it('keeps prevent and allow paired and ordered across fast route flips', async () => {
    const renderer = await render(['(app)', '(tabs)', '(0_home)']);
    expect(captureMock.calls).toEqual([]);

    await update(renderer, ['(app)', '(tabs)', '(3_profile)']);
    await update(renderer, ['(app)', '(tabs)', '(0_home)']);
    await update(renderer, ['(app)', '(tabs)', '(3_profile)', 'organization']);

    // The last call must be `prevent`: the route is covered, so a trailing
    // `allow` would leave FLAG_SECURE off on a sensitive screen.
    expect(captureMock.calls).toEqual(['prevent', 'allow', 'prevent']);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
    expect(captureMock.calls).toEqual(['prevent', 'allow', 'prevent', 'allow']);
  });

  it('never touches screen capture on iOS', async () => {
    reactNativeMock.Platform.OS = 'ios';
    const renderer = await render(['(app)', '(tabs)', '(3_profile)']);
    expect(captureMock.calls).toEqual([]);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
    expect(captureMock.calls).toEqual([]);
  });
});
