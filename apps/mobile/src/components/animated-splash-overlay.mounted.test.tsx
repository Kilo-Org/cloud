/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as offline-banner.mounted.test.tsx) */
import * as SplashScreen from 'expo-splash-screen';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markStartupComplete } from '@/lib/startup-timing';

import { AnimatedSplashOverlay } from './animated-splash-overlay';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (v: unknown) => ({ value: v }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
  // Reduced motion keeps animation callbacks out of the test.
  useReducedMotion: () => true,
}));
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: vi.fn(),
}));
vi.mock('expo-splash-screen', () => ({
  hideAsync: vi.fn().mockResolvedValue(undefined),
  preventAutoHideAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ TimeToFullDisplay: () => null }));
// String host so findByType works and props.onLoad stays callable.
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
// No Vitest project transforms .png.
vi.mock('@/../assets/images/logo.png', () => ({ default: 1 }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

async function mountOverlay(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(AnimatedSplashOverlay));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('AnimatedSplashOverlay mounted', () => {
  beforeEach(() => {
    // React 19 requires the act environment flag before `act` supports
    // updates scheduled from external stores (useSyncExternalStore).
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the logo frame, owns hideAsync, and unmounts visuals after completion', async () => {
    const renderer = await mountOverlay();

    // Before completion: the logo frame is mounted and hide has not fired.
    const logoImages = findByType(renderer.root, 'Image');
    expect(logoImages).toHaveLength(1);
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    const logoImage = logoImages[0];
    if (!logoImage) {
      throw new Error('expected one Image host');
    }

    // The logo asset decodes.
    act(() => {
      (logoImage.props.onLoad as () => void)();
    });

    // Gates settle.
    act(() => {
      markStartupComplete('app');
    });

    // Flush microtasks so the awaited hideAsync race settles and dismissal lands.
    await act(async () => {
      await Promise.resolve();
    });

    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
    expect(findByType(renderer.root, 'Image')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
